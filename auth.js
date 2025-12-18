import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const TOKEN_FILE = "./bling_token.json";
const OAUTH_URL = "https://www.bling.com.br/Api/v3/oauth/token";

let accessToken = null;
let refreshToken = null;
let expiresAt = 0;
let refreshingPromise = null;

/* =========================
   LOAD / SAVE TOKEN
========================= */

function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;

    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const data = JSON.parse(raw);

    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    expiresAt = data.expires_at || 0;

    console.log("🔑 Token do Bling carregado do disco");
  } catch (err) {
    console.warn("⚠️ Não foi possível carregar token salvo:", err.message);
  }
}

function saveToken(data) {
  const payload = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000 // 1 min de folga
  };

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2));
}

/* =========================
   REFRESH TOKEN
========================= */

async function refreshAccessToken() {
  if (refreshingPromise) {
    return refreshingPromise;
  }

  if (!refreshToken) {
    throw new Error(
      "❌ Refresh token do Bling inexistente. Acesse /oauth/login para autenticar."
    );
  }

  const auth = Buffer.from(
    `${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`
  ).toString("base64");

  refreshingPromise = axios
    .post(
      OAUTH_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 10000
      }
    )
    .then(r => {
      accessToken = r.data.access_token;
      refreshToken = r.data.refresh_token;
      expiresAt = Date.now() + r.data.expires_in * 1000 - 60_000;

      saveToken(r.data);
      refreshingPromise = null;

      console.log("🔄 Token do Bling renovado automaticamente");
      return accessToken;
    })
    .catch(err => {
      refreshingPromise = null;

      console.error(
        "❌ Erro ao renovar token do Bling:",
        err.response?.data || err.message
      );

      if (err.response?.data?.error === "invalid_grant") {
        throw new Error(
          "❌ Refresh token do Bling inválido ou expirado. Refaça o login OAuth."
        );
      }

      throw err;
    });

  return refreshingPromise;
}

/* =========================
   PUBLIC API
========================= */

export async function getAccessToken() {
  if (accessToken && Date.now() < expiresAt) {
    return accessToken;
  }

  return refreshAccessToken();
}

export async function bling() {
  const token = await getAccessToken();

  const api = axios.create({
    baseURL: "https://www.bling.com.br/Api/v3",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  api.interceptors.response.use(
    res => res,
    async err => {
      if (err.response?.status === 401) {
        console.warn("⚠️ 401 do Bling, renovando token...");
        const newToken = await refreshAccessToken();
        err.config.headers.Authorization = `Bearer ${newToken}`;
        return api(err.config);
      }
      throw err;
    }
  );

  return api;
}

/* =========================
   INIT
========================= */

loadToken();
