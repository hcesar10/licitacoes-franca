#!/usr/bin/env python3
"""Coleta licitações de Franca-SP e região no PNCP e grava docs/data/licitacoes.json.

Só stdlib. A API não filtra por município (codigoMunicipioIbge dá 504), então varre a UF
inteira e filtra no cliente por unidadeOrgao.codigoIbge. Faz merge com o JSON existente e só
grava se TODAS as páginas vieram — nunca publica coleta pela metade por cima de dado bom.

    python scripts/coletar.py                 # últimos 3 dias
    python scripts/coletar.py --dias 15       # carga inicial
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao"
TAMANHO_PAGINA = 50  # máximo aceito; >=100 dá HTTP 400
BRT = timezone(timedelta(hours=-3))
RETENCAO_DIAS = 30  # descarta o que encerrou (ou foi publicado, se sem prazo) há mais que isso
SAIDA_PADRAO = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "licitacoes.json")
USER_AGENT = "licitacoes-franca/1.0 (+https://github.com/hcesar10/licitacoes-franca)"

# Códigos confirmados na API do IBGE. Claraval e Ibiraci são de MG.
MUNICIPIOS = [
    {"nome": "Franca", "ibge": "3516200", "uf": "SP"},
    {"nome": "Cristais Paulista", "ibge": "3513207", "uf": "SP"},
    {"nome": "Claraval", "ibge": "3116407", "uf": "MG"},
    {"nome": "Restinga", "ibge": "3542701", "uf": "SP"},
    {"nome": "Patrocínio Paulista", "ibge": "3536307", "uf": "SP"},
    {"nome": "Itirapuã", "ibge": "3523701", "uf": "SP"},
    {"nome": "Ibiraci", "ibge": "3129707", "uf": "MG"},
    {"nome": "Ribeirão Corrente", "ibge": "3543105", "uf": "SP"},
]
POR_IBGE = {m["ibge"]: m for m in MUNICIPIOS}
RETENTAVEIS = {429, 500, 502, 503, 504}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get_json(url, tentativas=7):
    """GET com retry. 429/5xx em rajada é throttling: respeita Retry-After e faz backoff."""
    espera = 5
    for tentativa in range(1, tentativas + 1):
        motivo = None
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp:
                corpo = resp.read()
                if resp.status == 204 or not corpo.strip():
                    return None
                return json.loads(corpo.decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in RETENTAVEIS:
                raise
            motivo = f"HTTP {e.code}"
            retry_after = e.headers.get("Retry-After", "")
            if retry_after.isdigit():
                espera = max(espera, int(retry_after))
        except json.JSONDecodeError:
            motivo = "JSON inválido"
        # TimeoutError de leitura NÃO é URLError; sem capturar, mata o processo.
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            motivo = f"{type(e).__name__}: {e}"
        if tentativa == tentativas:
            break
        log(f"    {motivo} — tentativa {tentativa}/{tentativas}, aguardando {espera}s")
        time.sleep(espera)
        espera = min(espera * 2, 120)
    raise RuntimeError(f"falhou após {tentativas} tentativas ({motivo}): {url}")


def url_edital(cnpj, ano, sequencial):
    return f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{int(sequencial)}"


def normalizar(r, municipio):
    org = r.get("orgaoEntidade") or {}
    un = r.get("unidadeOrgao") or {}
    controle = r.get("numeroControlePNCP") or ""
    cnpj = org.get("cnpj")
    ano = r.get("anoCompra")
    seq = r.get("sequencialCompra")
    # Formato CNPJ-1-SEQUENCIAL/ANO
    m = re.match(r"^(\d{14})-\d+-(\d+)/(\d{4})$", controle)
    if m:
        cnpj = cnpj or m.group(1)
        seq = seq or int(m.group(2))
        ano = ano or int(m.group(3))
    amparo = r.get("amparoLegal") or {}
    return {
        "id": controle,
        "municipio": municipio["nome"],
        "ibge": municipio["ibge"],
        "uf": municipio["uf"],
        "orgao": org.get("razaoSocial"),
        "cnpj": cnpj,
        "unidade": un.get("nomeUnidade"),
        "objeto": (r.get("objetoCompra") or "").strip(),
        "modalidade": r.get("modalidadeNome"),
        "modalidadeId": r.get("modalidadeId"),
        "modoDisputa": r.get("modoDisputaNome"),
        "numeroCompra": r.get("numeroCompra"),
        "processo": r.get("processo"),
        "valorEstimado": r.get("valorTotalEstimado"),
        "valorHomologado": r.get("valorTotalHomologado"),
        "publicacao": r.get("dataPublicacaoPncp"),
        "abertura": r.get("dataAberturaProposta"),
        "encerramento": r.get("dataEncerramentoProposta"),
        "atualizacao": r.get("dataAtualizacao"),
        "situacao": r.get("situacaoCompraNome"),
        "srp": r.get("srp"),
        "amparoLegal": amparo.get("nome"),
        "linkOrigem": (r.get("linkSistemaOrigem") or "").strip() or None,
        "urlPncp": url_edital(cnpj, ano, seq) if cnpj and ano and seq else None,
        "ano": ano,
        "sequencial": seq,
    }


def coletar_uf(uf, modalidade, de, ate, pausa):
    achados = []
    pagina, total_paginas = 1, 1
    while pagina <= total_paginas:
        params = {
            "dataInicial": de, "dataFinal": ate, "codigoModalidadeContratacao": modalidade,
            "uf": uf, "pagina": pagina, "tamanhoPagina": TAMANHO_PAGINA,
        }
        dados = get_json(f"{API}?{urllib.parse.urlencode(params)}")
        if not dados or not dados.get("data"):
            break
        total_paginas = dados.get("totalPaginas") or pagina
        relevantes = 0
        for r in dados["data"]:
            ibge = str((r.get("unidadeOrgao") or {}).get("codigoIbge") or "")
            if ibge in POR_IBGE:
                achados.append(normalizar(r, POR_IBGE[ibge]))
                relevantes += 1
        log(f"  {uf} mod {modalidade}: página {pagina}/{total_paginas} (+{relevantes})")
        pagina += 1
        if pagina <= total_paginas:
            time.sleep(pausa)
    return achados


def parse_data(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    # A API devolve horário local sem fuso.
    return dt.replace(tzinfo=BRT) if dt.tzinfo is None else dt


def ainda_relevante(reg, agora):
    ref = parse_data(reg.get("encerramento")) or parse_data(reg.get("publicacao"))
    return ref is None or ref >= agora - timedelta(days=RETENCAO_DIAS)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dias", type=int, default=3, help="dias de publicação para trás (padrão 3)")
    ap.add_argument("--modalidades", default="6,8", help="códigos PNCP: 6=pregão eletrônico, 8=dispensa")
    ap.add_argument("--pausa", type=float, default=1.5, help="segundos entre páginas (padrão 1.5)")
    ap.add_argument("--saida", default=SAIDA_PADRAO)
    args = ap.parse_args()
    if not 1 <= args.dias <= 90:
        ap.error("--dias deve estar entre 1 e 90")

    agora = datetime.now(BRT)
    de = (agora - timedelta(days=args.dias)).strftime("%Y%m%d")
    ate = agora.strftime("%Y%m%d")
    modalidades = [int(m) for m in args.modalidades.split(",") if m.strip()]
    ufs = sorted({m["uf"] for m in MUNICIPIOS})
    log(f"Coletando {de}..{ate}, UFs {ufs}, modalidades {modalidades}")

    novos = []
    try:
        for uf in ufs:
            for mod in modalidades:
                novos.extend(coletar_uf(uf, mod, de, ate, args.pausa))
                time.sleep(args.pausa)
    except Exception as e:  # noqa: BLE001 — qualquer falha aborta sem gravar
        log(f"ERRO: {e}\nNada foi gravado; o JSON anterior continua valendo.")
        return 1

    saida = os.path.abspath(args.saida)
    registros = {}
    if os.path.exists(saida):
        with open(saida, encoding="utf-8") as f:
            registros = {r["id"]: r for r in json.load(f).get("licitacoes", [])}
    antes = len(registros)
    for reg in novos:
        registros[reg["id"]] = reg
    mantidos = [r for r in registros.values() if ainda_relevante(r, agora)]
    mantidos.sort(key=lambda r: r.get("publicacao") or "", reverse=True)

    contagem = {m["ibge"]: 0 for m in MUNICIPIOS}
    for r in mantidos:
        contagem[r["ibge"]] += 1

    doc = {
        "atualizadoEm": agora.isoformat(timespec="seconds"),
        "ultimaColeta": {"de": de, "ate": ate, "modalidades": modalidades, "encontrados": len(novos)},
        "retencaoDias": RETENCAO_DIAS,
        "municipios": [{**m, "total": contagem[m["ibge"]]} for m in MUNICIPIOS],
        "licitacoes": mantidos,
    }
    os.makedirs(os.path.dirname(saida), exist_ok=True)
    tmp = saida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, saida)

    log(f"OK: {len(novos)} achados nesta coleta; arquivo tinha {antes}, agora {len(mantidos)}.")
    for m in doc["municipios"]:
        log(f"  {m['nome']:<20} {m['total']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
