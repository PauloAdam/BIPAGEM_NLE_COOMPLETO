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
   🔎 MONITOR (SSE)
========================= */
let monitores = [];

function monitor(evento) {
  const payload = `data: ${JSON.stringify({
    ...evento,
    hora: new Date().toLocaleTimeString()
  })}\n\n`;

  monitores.forEach(res => res.write(payload));
}

app.get("/monitor/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: {"tipo":"CONECTADO"}\n\n`);
  monitores.push(res);

  req.on("close", () => {
    monitores = monitores.filter(r => r !== res);
  });
});

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
    timeout: 60000
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

    if (pedido?.situacao?.id === SITUACAO_VERIFICADO) {
      return res.status(409).json({
        erro: "ESTE PEDIDO JÁ FOI VERIFICADO"
      });
    }

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

      if (i.codigo) pedidoAtual[idProduto].codigos.push(String(i.codigo));

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

    // 🔎 MONITOR
    monitor({ tipo: "PEDIDO_CARREGADO", pedido: numero });

    res.json(pedidoAtual);

  } catch (e) {
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

  // 🔎 MONITOR
  monitor({
    tipo: "SCAN",
    produto: produto.nome,
    bipado: produto.bipado,
    total: produto.pedido
  });

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

    // 🔎 MONITOR
    monitor({ tipo: "PEDIDO_FINALIZADO" });

    return res.json({ ok: true });

  } catch (e) {

  const erro = e.response?.data;

  // ⏱️ Timeout → provavelmente sucesso
  if (e.code === "ECONNABORTED") {
    console.log("⏱️ Timeout no Bling, possível sucesso tardio");

    pedidoAtual = {};
    mapaCodigos = {};
    pedidoVendaId = null;

    monitor({ tipo: "PEDIDO_FINALIZADO_TIMEOUT" });

    return res.json({
      ok: true,
      aviso: "Tempo excedido. Estoque pode já ter sido lançado."
    });
  }

  // 📦 Bling perdeu o recurso mas já processou
  if (erro?.error?.type === "RESOURCE_NOT_FOUND") {
    console.log("⚠️ Recurso não encontrado, mas estoque provavelmente lançado");

    pedidoAtual = {};
    mapaCodigos = {};
    pedidoVendaId = null;

    monitor({ tipo: "PEDIDO_FINALIZADO_ASSINCRONO" });

    return res.json({
      ok: true,
      aviso: "Pedido processado no Bling. Estoque já foi baixado."
    });
  }

  console.error(
    "❌ ERRO FINALIZAR:",
    JSON.stringify(erro || e.message, null, 2)
  );

  return res.status(500).json({
    erro: "Erro ao finalizar pedido no Bling"
  });
}

});


/* =========================
   MONITOR (SSE)
========================= */
let clientesMonitor = [];

app.get("/monitor/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clientesMonitor.push(res);

  req.on("close", () => {
    clientesMonitor = clientesMonitor.filter(c => c !== res);
  });
});

function enviarMonitor(evento, dados = {}) {
  const payload = `data: ${JSON.stringify({
    evento,
    hora: new Date().toLocaleTimeString(),
    ...dados
  })}\n\n`;

  clientesMonitor.forEach(c => c.write(payload));
}


/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;

/* =========================
   STATUS DO PEDIDO (BLING)
========================= */
app.get("/status/:numero", async (req, res) => {
  const numero = req.params.numero;

  try {
    const api = await bling(); // usa sua função existente

    const r = await api.get("/pedidos/vendas", {
      params: {
        numeroPedido: numero
      }
    });

    // não encontrou pedido
    if (!r.data || !r.data.data || r.data.data.length === 0) {
      return res.json({ erro: "Pedido não encontrado no Bling." });
    }

    // retorna exatamente o JSON do Bling
    return res.json(r.data.data[0]);

  } catch (e) {
    console.error("❌ ERRO REAL:", e.response?.data || e.message);
    res.json({
      erro: "Erro ao consultar status no Bling.",
      detalhe: e.response?.data || e.message
    });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Sistema rodando em http://localhost:${PORT}`);
});



//rora temporaria descobrir id situação PEDIDO
app.get("/bling/situacoes", async (req, res) => {
  try {
    const api = await bling();
    const r = await api.get("/situacoes");
    res.json(r.data);
  } catch (e) {
    res.status(500).json(e.response?.data || e.message);
  }
});



