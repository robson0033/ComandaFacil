const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const viewPath = path.join(
  __dirname,
  '..',
  'src',
  'views',
  'admin-real.ejs'
);

const source = fs.readFileSync(viewPath, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `função ${name} não encontrada`);

  const braceStart = source.indexOf('{', start);
  assert.notEqual(braceStart, -1, `abertura de ${name} não encontrada`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let templateExpressionDepth = 0;

  for (let index = braceStart; index < source.length; index += 1) {
    const character = source[index];
    const previous = source[index - 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote) {
      if (character === '\\') {
        escaped = true;
        continue;
      }

      if (quote === '`' && character === '$' && source[index + 1] === '{') {
        templateExpressionDepth += 1;
        index += 1;
        depth += 1;
        continue;
      }

      if (character === quote && templateExpressionDepth === 0) {
        quote = null;
      }

      if (quote === '`' && templateExpressionDepth > 0) {
        if (character === '{') depth += 1;
        if (character === '}') {
          depth -= 1;
          templateExpressionDepth -= 1;
        }
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 1;
      continue;
    }

    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }

    if (previous === '$' && character === '{') {
      templateExpressionDepth += 1;
    }
  }

  throw new Error(`fim da função ${name} não encontrado`);
}

test('pesquisa de pedidos é inicializada cedo e sem listeners duplicados', () => {
  const initialization = source.indexOf('initializeOrdersTextSearch();');
  const notifications = source.indexOf('const podeReceberNotificacoes');

  assert.ok(initialization > 0);
  assert.ok(notifications > initialization);
  assert.equal(
    source.match(/addEventListener\('input', filterOrdersByText\)/g)?.length,
    1
  );
  assert.equal(
    source.match(/addEventListener\('search', filterOrdersByText\)/g)?.length,
    1
  );
  assert.match(source, /ordersSearchReady/);
});

test('normalização ignora acentos, maiúsculas e pontuação', () => {
  const normalizeSource = extractFunction('normalizeOrderSearch');
  const context = {};
  vm.runInNewContext(`${normalizeSource}; this.normalizeOrderSearch = normalizeOrderSearch;`, context);

  assert.equal(
    context.normalizeOrderSearch('  João, Número 03 — CENTRO!  '),
    'joao numero 03 centro'
  );
});

test('pedidos inseridos em tempo real recebem índice completo de pesquisa', () => {
  assert.match(
    source,
    /artigo\.dataset\.orderSearch\s*=\s*buildOrderSearchText\(pedido\)/
  );

  for (const field of [
    'pedido.numero',
    'pedido.cliente',
    'pedido.telefone',
    'pedido.rua',
    'pedido.numeroEndereco',
    'pedido.bairro',
    'pedido.referencia',
  ]) {
    assert.match(source, new RegExp(field.replace('.', '\\.')));
  }
});

test('pesquisa usa índice e texto renderizado, atualiza contador e estado vazio', () => {
  const normalizeSource = extractFunction('normalizeOrderSearch');
  const filterSource = extractFunction('filterOrdersByText');

  function makeCard({ indexed = '', text = '' }) {
    const state = new Set();
    return {
      dataset: { orderSearch: indexed },
      textContent: text,
      classList: {
        toggle(name, enabled) {
          if (enabled) state.add(name);
          else state.delete(name);
        },
        contains(name) {
          return state.has(name);
        },
      },
    };
  }

  const matchingCard = makeCard({
    text: 'Referência: ao lado da casa do cara legal',
  });
  const hiddenCard = makeCard({
    indexed: '0495f845 outro cliente centro',
  });
  const input = { value: 'CASA LEGAL' };
  const count = { textContent: '' };
  let noResultsVisible = null;
  const noResults = {
    classList: {
      toggle(name, enabled) {
        if (name === 'visible') noResultsVisible = enabled;
      },
    },
  };

  const context = {
    document: {
      querySelector(selector) {
        return {
          '#ordersTextSearch': input,
          '#ordersVisibleCount': count,
          '#ordersSearchNoResults': noResults,
        }[selector] || null;
      },
      querySelectorAll(selector) {
        assert.equal(selector, '#ordersGrid .order-card');
        return [matchingCard, hiddenCard];
      },
    },
  };

  vm.runInNewContext(
    `${normalizeSource}\n${filterSource}\nthis.filterOrdersByText = filterOrdersByText;`,
    context
  );
  context.filterOrdersByText();

  assert.equal(matchingCard.classList.contains('order-filter-hidden'), false);
  assert.equal(hiddenCard.classList.contains('order-filter-hidden'), true);
  assert.equal(count.textContent, '1');
  assert.equal(noResultsVisible, false);
});
