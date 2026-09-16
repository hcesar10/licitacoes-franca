"use strict";

const DADOS_URL = "data/licitacoes.json";
const ITENS_URL = (cnpj, ano, seq) =>
  `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens`;
const FRANCA = "3516200";
const HORAS_DADO_VELHO = 36;

const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const numero = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 });
const dataHora = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

const estado = {
  dados: null,
  selecionados: new Set([FRANCA]),
};

/* ---------- utilidades ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function semAcento(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// A API devolve horário local de Brasília sem fuso.
function parseData(s) {
  if (!s) return null;
  const temFuso = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const d = new Date(temFuso ? s : `${s}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inativa(l) {
  return /revogad|anulad|suspens|cancelad/i.test(l.situacao || "");
}

function aberta(l, agora) {
  const fim = parseData(l.encerramento);
  return !!fim && fim > agora && !inativa(l);
}

function prazo(l, agora) {
  const fim = parseData(l.encerramento);
  if (inativa(l)) return { texto: l.situacao, classe: "prazo-fechado" };
  if (!fim) return { texto: "Sem prazo informado", classe: "prazo-fechado" };
  const ms = fim - agora;
  if (ms <= 0) return { texto: "Encerrada", classe: "prazo-fechado" };
  const horas = ms / 36e5;
  if (horas < 24) {
    const h = Math.max(1, Math.floor(horas));
    return { texto: `Encerra em ${h} h`, classe: "prazo-urgente" };
  }
  const dias = Math.floor(horas / 24);
  return {
    texto: dias === 1 ? "Encerra amanhã" : `Encerra em ${dias} dias`,
    classe: dias <= 2 ? "prazo-urgente" : dias <= 5 ? "prazo-breve" : "",
  };
}

/* ---------- carregamento ---------- */

async function carregar() {
  const btn = $("#btn-carregar");
  const status = $("#status");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Carregando…";
  try {
    const resp = await fetch(`${DADOS_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    estado.dados = await resp.json();
    mostrarStatus();
    $("#painel").hidden = false;
    btn.textContent = "Recarregar";
    renderizar();
  } catch (e) {
    status.className = "status erro";
    status.textContent = `Não consegui carregar os dados (${e.message}). Tente de novo em instantes.`;
  } finally {
    btn.disabled = false;
  }
}

function mostrarStatus() {
  const atualizado = parseData(estado.dados.atualizadoEm);
  const status = $("#status");
  if (!atualizado) { status.textContent = ""; return; }
  const horas = (Date.now() - atualizado) / 36e5;
  status.innerHTML = `Dados atualizados em <strong>${esc(dataHora.format(atualizado))}</strong>` +
    (horas > HORAS_DADO_VELHO ? ` · <span class="velho">podem estar desatualizados</span>` : "");
}

/* ---------- filtros e renderização ---------- */

function filtrosAtuais() {
  return {
    texto: semAcento($("#f-texto").value.trim()),
    modalidade: $("#f-modalidade").value,
    valorMax: parseFloat($("#f-valor").value) || null,
    ordem: $("#f-ordem").value,
    abertas: $("#f-abertas").checked,
  };
}

function passaFiltros(l, f, agora) {
  if (f.abertas && !aberta(l, agora)) return false;
  if (f.modalidade && String(l.modalidadeId) !== f.modalidade) return false;
  if (f.valorMax !== null && (l.valorEstimado ?? 0) > f.valorMax) return false;
  if (f.texto) {
    const alvo = semAcento(`${l.objeto} ${l.orgao} ${l.unidade}`);
    if (!f.texto.split(/\s+/).every((p) => alvo.includes(p))) return false;
  }
  return true;
}

function ordenar(lista, ordem) {
  const chave = {
    encerra: (a, b) => (parseData(a.encerramento) ?? Infinity) - (parseData(b.encerramento) ?? Infinity),
    recentes: (a, b) => (b.publicacao || "").localeCompare(a.publicacao || ""),
    valor: (a, b) => (b.valorEstimado ?? 0) - (a.valorEstimado ?? 0),
  }[ordem];
  return lista.sort(chave);
}

function renderizar() {
  const { dados } = estado;
  if (!dados) return;
  const agora = new Date();
  const f = filtrosAtuais();
  const base = dados.licitacoes.filter((l) => passaFiltros(l, f, agora));

  const contagem = Object.fromEntries(dados.municipios.map((m) => [m.ibge, 0]));
  base.forEach((l) => { contagem[l.ibge] = (contagem[l.ibge] ?? 0) + 1; });
  renderizarChips(dados.municipios, contagem);

  const visiveis = ordenar(base.filter((l) => estado.selecionados.has(l.ibge)), f.ordem);
  const total = visiveis.length;
  const nomes = dados.municipios.filter((m) => estado.selecionados.has(m.ibge)).map((m) => m.nome);
  $("#resumo").innerHTML = nomes.length
    ? `<strong>${total}</strong> ${total === 1 ? "licitação" : "licitações"}${f.abertas ? " com proposta aberta" : ""} em ${esc(listaNomes(nomes))}`
    : "Selecione ao menos um município.";

  const semPncp = dados.municipios.filter((m) => m.total === 0).map((m) => m.nome);
  const aviso = $("#aviso-vazios");
  aviso.hidden = semPncp.length === 0;
  aviso.textContent = semPncp.length
    ? `Sem nenhuma publicação no PNCP nos últimos ${dados.retencaoDias} dias: ${listaNomes(semPncp)}. ` +
      "Cidades pequenas às vezes publicam só no próprio site ou diário oficial, então vale conferir lá."
    : "";

  const ul = $("#lista");
  if (!total) {
    ul.innerHTML = `<li class="vazio">Nada encontrado com esses filtros.${f.abertas ? " Experimente desmarcar “Só com proposta aberta”." : ""}</li>`;
    return;
  }
  ul.innerHTML = visiveis.map((l) => card(l, agora)).join("");
}

function listaNomes(nomes) {
  return nomes.length > 1 ? `${nomes.slice(0, -1).join(", ")} e ${nomes.at(-1)}` : nomes[0] || "";
}

function renderizarChips(municipios, contagem) {
  const todos = municipios.every((m) => estado.selecionados.has(m.ibge));
  const chips = municipios.map((m) => `
    <button type="button" class="chip${m.ibge === FRANCA ? " chip-destaque" : ""}" data-ibge="${m.ibge}"
      aria-pressed="${estado.selecionados.has(m.ibge)}">
      ${esc(m.nome)}${m.uf !== "SP" ? ` <small>${esc(m.uf)}</small>` : ""}
      <span class="n" aria-label="${contagem[m.ibge]} licitações">${contagem[m.ibge]}</span>
    </button>`);
  chips.push(`<button type="button" class="chip chip-todas" data-ibge="*" aria-pressed="${todos}">
    ${todos ? "Só Franca" : "Todas as cidades"}</button>`);
  $("#chips").innerHTML = chips.join("");
}

function card(l, agora) {
  const p = prazo(l, agora);
  const valor = l.valorEstimado ? brl.format(l.valorEstimado) : "Não informado";
  const fim = parseData(l.encerramento);
  const podeItens = l.cnpj && l.ano && l.sequencial;
  return `
  <li class="card" data-id="${esc(l.id)}">
    <div class="card-topo">
      <span class="tag tag-mun">${esc(l.municipio)}${l.uf !== "SP" ? ` · ${esc(l.uf)}` : ""}</span>
      <span class="tag">${esc(l.modalidade || "")}</span>
      ${l.srp ? `<span class="tag" title="Sistema de Registro de Preços: preço travado por até 12 meses e outros órgãos podem aderir">Registro de preços</span>` : ""}
      ${inativa(l) ? `<span class="tag tag-alerta">${esc(l.situacao)}</span>` : ""}
    </div>
    <p class="card-orgao">${esc(l.orgao || "")}${l.unidade && l.unidade !== l.orgao ? ` · ${esc(l.unidade)}` : ""}</p>
    <p class="card-objeto">${esc(l.objeto || "(sem descrição)")}</p>
    <dl class="card-dados">
      <div><dt>Valor estimado</dt><dd class="valor">${valor}</dd></div>
      <div><dt>Prazo da proposta</dt><dd class="prazo ${p.classe}">${esc(p.texto)}${fim ? ` <span class="nota">(${esc(dataHora.format(fim))})</span>` : ""}</dd></div>
      <div><dt>Publicada</dt><dd>${l.publicacao ? esc(dataHora.format(parseData(l.publicacao))) : "—"}</dd></div>
    </dl>
    <div class="card-acoes">
      ${podeItens ? `<button type="button" class="btn btn-secundario btn-pequeno" data-itens aria-expanded="false">Ver itens</button>` : ""}
      ${l.urlPncp ? `<a href="${esc(l.urlPncp)}" target="_blank" rel="noopener">Edital no PNCP ↗</a>` : ""}
      ${l.linkOrigem ? `<a href="${esc(l.linkOrigem)}" target="_blank" rel="noopener">Sistema de origem ↗</a>` : ""}
    </div>
    <div class="itens" hidden></div>
  </li>`;
}

/* ---------- itens (ao vivo no PNCP) ---------- */

async function buscarItens(l, tentativas = 3) {
  let espera = 1500;
  for (let t = 1; t <= tentativas; t++) {
    try {
      const resp = await fetch(ITENS_URL(l.cnpj, l.ano, l.sequencial), { headers: { Accept: "application/json" } });
      if (resp.status === 204) return [];
      if (resp.ok) return await resp.json();
      if (![429, 500, 502, 503, 504].includes(resp.status)) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
      if (t === tentativas) throw e;
    }
    if (t < tentativas) { await new Promise((r) => setTimeout(r, espera)); espera *= 2; }
  }
  throw new Error("o PNCP está instável agora");
}

async function alternarItens(botao) {
  const li = botao.closest(".card");
  const caixa = li.querySelector(".itens");
  const abrir = caixa.hidden;
  caixa.hidden = !abrir;
  botao.setAttribute("aria-expanded", String(abrir));
  botao.textContent = abrir ? "Esconder itens" : "Ver itens";
  if (!abrir || caixa.dataset.carregado) return;

  const l = estado.dados.licitacoes.find((x) => x.id === li.dataset.id);
  caixa.innerHTML = `<p class="itens-msg">Buscando itens no PNCP…</p>`;
  try {
    const itens = await buscarItens(l);
    caixa.dataset.carregado = "1";
    caixa.innerHTML = itens.length ? tabelaItens(itens)
      : `<p class="itens-msg">O órgão não publicou itens para esta licitação no PNCP. Veja o edital.</p>`;
  } catch (e) {
    caixa.innerHTML = `<p class="itens-msg erro">Não consegui buscar os itens (${esc(e.message)}).
      <button type="button" class="btn-link" data-tentar>Tentar de novo</button></p>`;
  }
}

function tabelaItens(itens) {
  const linhas = itens.map((i) => `
    <tr>
      <td class="num">${esc(i.numeroItem)}</td>
      <td>${esc(i.descricao)}${i.materialOuServicoNome ? ` <span class="nota">(${esc(i.materialOuServicoNome)})</span>` : ""}</td>
      <td class="num">${i.quantidade != null ? esc(numero.format(i.quantidade)) : "—"}</td>
      <td><span class="unidade">${esc(i.unidadeMedida || "—")}</span></td>
      <td class="num">${i.valorUnitarioEstimado ? brl.format(i.valorUnitarioEstimado) : "—"}</td>
      <td class="num">${i.valorTotal ? brl.format(i.valorTotal) : "—"}</td>
    </tr>`).join("");
  return `
    <p class="itens-msg">${itens.length} ${itens.length === 1 ? "item" : "itens"} · <strong>confira a unidade</strong> antes de cotar.</p>
    <div class="tabela-wrap">
      <table>
        <thead><tr><th class="num">#</th><th>Descrição</th><th class="num">Qtd.</th><th>Unidade</th><th class="num">Unit. estimado</th><th class="num">Total</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}

/* ---------- modal do passo a passo ---------- */

const modal = $("#modal");
const passos = [...modal.querySelectorAll(".passo")];
let passoAtual = 0;

function montarPontos() {
  $("#passos-pontos").innerHTML = passos.map((p, i) =>
    `<li><button type="button" class="ponto" data-passo="${i}" aria-label="Passo ${i + 1}: ${esc(p.dataset.titulo)}">${i + 1}. ${esc(p.dataset.titulo)}</button></li>`
  ).join("");
}

function irPara(i) {
  passoAtual = Math.max(0, Math.min(passos.length - 1, i));
  passos.forEach((p, n) => { p.hidden = n !== passoAtual; });
  modal.querySelectorAll(".ponto").forEach((b, n) => {
    if (n === passoAtual) {
      b.setAttribute("aria-current", "step");
      b.classList.add("visto");
      b.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      b.removeAttribute("aria-current");
    }
  });
  $("#passo-anterior").disabled = passoAtual === 0;
  $("#passo-proximo").textContent = passoAtual === passos.length - 1 ? "Entendi" : "Próximo →";
  $("#modal-corpo").scrollTop = 0;
}

function abrirModal() {
  irPara(passoAtual);
  modal.showModal();
  $("#modal-corpo").focus();
}

/* ---------- eventos ---------- */

$("#btn-carregar").addEventListener("click", carregar);
$("#btn-info").addEventListener("click", abrirModal);

["#f-texto", "#f-modalidade", "#f-valor", "#f-ordem", "#f-abertas"].forEach((sel) =>
  $(sel).addEventListener(sel === "#f-texto" ? "input" : "change", renderizar));

$("#chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const ibge = chip.dataset.ibge;
  if (ibge === "*") {
    const todos = estado.dados.municipios.every((m) => estado.selecionados.has(m.ibge));
    estado.selecionados = todos ? new Set([FRANCA]) : new Set(estado.dados.municipios.map((m) => m.ibge));
  } else if (estado.selecionados.has(ibge)) {
    estado.selecionados.delete(ibge);
  } else {
    estado.selecionados.add(ibge);
  }
  renderizar();
  $(`#chips .chip[data-ibge="${ibge}"]`)?.focus();
});

$("#lista").addEventListener("click", (e) => {
  const itens = e.target.closest("[data-itens]");
  if (itens) return alternarItens(itens);
  const tentar = e.target.closest("[data-tentar]");
  if (tentar) {
    const botao = tentar.closest(".card").querySelector("[data-itens]");
    botao.closest(".card").querySelector(".itens").hidden = true;
    alternarItens(botao);
  }
});

montarPontos();
$("#passos-pontos").addEventListener("click", (e) => {
  const b = e.target.closest(".ponto");
  if (b) irPara(Number(b.dataset.passo));
});
$("#passo-anterior").addEventListener("click", () => irPara(passoAtual - 1));
$("#passo-proximo").addEventListener("click", () => {
  if (passoAtual === passos.length - 1) { modal.close(); passoAtual = 0; } else irPara(passoAtual + 1);
});
modal.addEventListener("click", (e) => {
  if (e.target === modal || e.target.closest("[data-fechar]")) modal.close();
});
modal.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.key === "ArrowRight") irPara(passoAtual + 1);
  if (e.key === "ArrowLeft") irPara(passoAtual - 1);
});
modal.addEventListener("close", () => $("#btn-info").focus());
