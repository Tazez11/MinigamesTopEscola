// Teste rápido (não faz parte do jogo):
// 1) busca 5 personagens populares na AniList
// 2) baixa a imagem do primeiro e gera versões pixeladas dela na pasta "teste-pixel"

const fs = require('fs');
const sharp = require('sharp');

const QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    characters(sort: FAVOURITES_DESC) {
      id
      name { full native alternative }
      image { large }
      media(perPage: 1, sort: POPULARITY_DESC) {
        nodes { title { romaji english } }
      }
    }
  }
}`;

async function main() {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { page: 1, perPage: 5 } })
  });
  console.log('Status da API:', res.status);

  const json = await res.json();
  if (json.errors) {
    console.error('A API devolveu erro:', JSON.stringify(json.errors));
    return;
  }

  const list = json.data.Page.characters;
  console.log('\nPersonagens recebidos:');
  list.forEach((c) => {
    const anime = c.media.nodes[0] ? c.media.nodes[0].title.romaji : '(sem anime)';
    console.log('-', c.name.full, '| anime:', anime, '| outros nomes:', (c.name.alternative || []).join(', ') || '(nenhum)');
  });

  const first = list[0];
  console.log('\nBaixando a imagem de', first.name.full, '...');
  const imgRes = await fetch(first.image.large);
  const original = Buffer.from(await imgRes.arrayBuffer());
  const meta = await sharp(original).metadata();
  console.log('Imagem original:', meta.width + 'x' + meta.height, '(' + Math.round(original.length / 1024) + ' KB)');

  fs.mkdirSync('teste-pixel', { recursive: true });

  // Quanto menor a largura, mais pixelada fica a imagem final.
  for (const width of [6, 12, 24, 48]) {
    const tiny = await sharp(original).resize(width, null, { kernel: 'nearest' }).toBuffer();
    const info = await sharp(tiny)
      .resize(meta.width, meta.height, { fit: 'fill', kernel: 'nearest' })
      .jpeg({ quality: 80 })
      .toFile('teste-pixel/nivel-' + width + '.jpg');
    console.log('Gerada teste-pixel/nivel-' + width + '.jpg (' + Math.round(info.size / 1024) + ' KB)');
  }

  console.log('\nPronto! Abra a pasta "teste-pixel" e veja se as imagens ficam mais nítidas de 6 para 48.');
}

main().catch((err) => console.error('Deu erro:', err.message));
