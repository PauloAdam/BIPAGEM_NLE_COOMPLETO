import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { getAccessToken } from "./auth.js";

dotenv.config();

/* =========================
   APP
========================= */
const app = express();
app.use(express.json());
app.use(express.static("public"));

const BLING = "https://www.bling.com.br/Api/v3";

/* =========================
   SITUAÇÕES (SUA CONTA)
========================= */
const SITUACAO_ABERTO = 6;
const SITUACAO_ANDAMENTO = 15;
const SITUACAO_VERIFICADO = Number(process.env.BLING_SITUACAO_VERIFICADO_ID);

/* =========================
   ESTADO
========================= */
let pedidoAtual = {};
let mapaCodigos = {};
let pedidoVendaId = null;
let blingOcupado = false;

/* =========================
   CLIENTE BLING
========================= */
async function bling() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: BLING,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    timeout: 15000
  });
}

/* =========================
   OAUTH LOGIN
========================= */
app.get("/oauth/login", (req, res) => {
  const state = Math.random().toString(36).substring(2);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.BLING_CLIENT_ID,
    redirect_uri: process.env.BLING_REDIRECT_URI,
    state
  });

  res.redirect(
    `https://www.bling.com.br/Api/v3/oauth/authorize?${params}`
  );
});

/* =========================
   OAUTH CALLBACK
========================= */
app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("❌ Code não recebido do Bling");

  try {
    const response = await axios.post(
      "https://www.bling.com.br/Api/v3/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.BLING_REDIRECT_URI
      }),
      {
        auth: {
          username: process.env.BLING_CLIENT_ID,
          password: process.env.BLING_CLIENT_SECRET
        }
      }
    );

    const token = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: Date.now() + response.data.expires_in * 1000
    };

    fs.writeFileSync("./bling_token.json", JSON.stringify(token, null, 2));

    res.send("✅ Bling autenticado com sucesso. Pode fechar esta página.");
  } catch (e) {
    console.error("OAuth error:", e.response?.data || e.message);
    res.status(500).send("Erro ao autenticar no Bling");
  }
});

/* =========================
   STATUS BLING
========================= */
app.get("/bling/status", async (req, res) => {
  try {
    const api = await bling();
    await api.get("/produtos", { params: { limite: 1 } });
    res.json({ conectado: true });
  } catch (e) {
    res.status(500).json({
      conectado: false,
      erro: e.response?.data || e.message
    });
  }
});

/* =========================
   BUSCAR PEDIDO
========================= */
app.get("/pedido/:numero", async (req, res) => {
  if (blingOcupado) {
    return res.status(429).json({
      erro: "Aguarde, pedido em processamento..."
    });
  }

  blingOcupado = true;

  try {
    const api = await bling();
    const numero = Number(req.params.numero);

    if (!numero) {
      return res.status(400).json({
        erro: "Número de pedido inválido"
      });
    }

    const lista = await api.get("/pedidos/vendas", {
      params: { numero }
    });

    const pedidos = lista.data?.data;
    if (!Array.isArray(pedidos) || !pedidos.length) {
      return res.status(404).json({
        erro: "Pedido não encontrado"
      });
    }

    pedidoVendaId = pedidos[0].id;

    const detalhe = await api.get(`/pedidos/vendas/${pedidoVendaId}`);
    const pedido = detalhe.data?.data;

    // 🔒 BLOQUEIA VERIFICADO
    if (pedido?.situacao?.id === SITUACAO_VERIFICADO) {
      return res.status(409).json({
        erro: "ESTE PEDIDO JÁ FOI VERIFICADO"
      });
    }

    // 🔄 MUDA PARA EM ANDAMENTO (SEM MUDAR SUA LÓGICA)
    if (pedido?.situacao?.id === SITUACAO_ABERTO) {
      await api.patch(
        `/pedidos/vendas/${pedidoVendaId}/situacoes/${SITUACAO_ANDAMENTO}`
      );
    }

    pedidoAtual = {};
    mapaCodigos = {};

    for (const i of pedido.itens) {
      const idProduto = i.produto.id;

      pedidoAtual[idProduto] = {
        idProduto,
        nome: i.descricao,
        pedido: Number(i.quantidade),
        bipado: 0,
        codigos: []
      };

      if (i.codigo) {
        pedidoAtual[idProduto].codigos.push(String(i.codigo));
      }

      try {
        const prod = await api.get(`/produtos/${idProduto}`);
        const p = prod.data?.data;
        if (p?.codigoBarras) pedidoAtual[idProduto].codigos.push(String(p.codigoBarras));
        if (p?.gtin) pedidoAtual[idProduto].codigos.push(String(p.gtin));
      } catch {}

      pedidoAtual[idProduto].codigos.forEach(c => {
        mapaCodigos[c] = idProduto;
      });
    }

    res.json(pedidoAtual);

  } catch (e) {
    console.error(
      "Erro Bling:",
      JSON.stringify(e.response?.data || e.message, null, 2)
    );
    res.status(500).json({
      erro: "Erro ao carregar pedido"
    });
  } finally {
    blingOcupado = false;
  }
});

/* =========================
   SCAN
========================= */
app.post("/scan", (req, res) => {
  const { codigo } = req.body;
  const idProduto = mapaCodigos[codigo];

  if (!idProduto) {
    return res.status(400).json({
      erro: "Produto não pertence ao pedido"
    });
  }

  const produto = pedidoAtual[idProduto];

  if (produto.bipado >= produto.pedido) {
    return res.status(400).json({
      erro: "Quantidade excedida"
    });
  }

  produto.bipado++;

  res.json({
    idProduto,
    bipado: produto.bipado
  });
});

/* =========================
   FINALIZAR
========================= */
app.post("/finalizar", async (req, res) => {
  if (!pedidoVendaId) {
    return res.status(400).json({
      erro: "Pedido não carregado"
    });
  }

  try {
    const api = await bling();

    await api.post(`/pedidos/vendas/${pedidoVendaId}/lancar-estoque`);
    await api.patch(
      `/pedidos/vendas/${pedidoVendaId}/situacoes/${SITUACAO_VERIFICADO}`
    );

    pedidoAtual = {};
    mapaCodigos = {};
    pedidoVendaId = null;

    res.json({ ok: true });

  } catch (e) {
    console.error(
      "Erro ao finalizar:",
      JSON.stringify(e.response?.data, null, 2)
    );
    res.status(500).json({
      erro: "Erro ao finalizar pedido no Bling"
    });
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Sistema rodando em http://localhost:${PORT}`);
  console.log(`👉 OAuth: http://localhost:${PORT}/oauth/login`);
});

/* =========================
  ABERTO → 6
  EM ANDAMENTO → 15
  VERIFICADO → 24
========================= */

/* =========================
  ABERTO → id = 6

EM ANDAMENTO → id = 15

VERIFICADO → id = 24
========================= */
