# Licitações de Franca e região

Painel independente com dispensas e pregões eletrônicos publicados no
[PNCP](https://pncp.gov.br) por órgãos de Franca-SP, Cristais Paulista, Claraval (MG), Restinga,
Patrocínio Paulista, Itirapuã, Ibiraci (MG) e Ribeirão Corrente.

**Página:** https://hcesar10.github.io/licitacoes-franca/

## Como funciona

- `scripts/coletar.py` (Python 3, só stdlib) varre a API de consulta do PNCP por UF (SP e MG),
  filtra pelos códigos IBGE das cidades e grava `docs/data/licitacoes.json`, fazendo merge com o
  que já existe. Se alguma página falhar depois dos retries, nada é gravado.
- `.github/workflows/coletar.yml` roda o coletor às 07h e 18h (Brasília) e comita o JSON.
  Para rodar na hora: aba **Actions → Coletar licitações → Run workflow**.
- `docs/` é a página estática (GitHub Pages). Os itens de cada licitação são buscados ao vivo
  na API do PNCP pelo navegador.

## Rodar localmente

```bash
python scripts/coletar.py --dias 3
python -m http.server -d docs 8000   # abrir http://localhost:8000
```

Conteúdo informativo; não é consultoria jurídica. Sempre confira o edital oficial.
