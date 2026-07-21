import { webFetch } from './tools/web_fetch';
import { webSearch } from './tools/web_search';

async function run() {
  console.log('--- web_fetch: https://example.com ---');
  const fetchResult = await webFetch({ url: 'https://example.com' });
  console.log(fetchResult.slice(0, 300));

  console.log('\n--- web_search: python programming language ---');
  const searchResult = await webSearch({ query: 'python programming language' });
  console.log(searchResult);

  console.log('\n--- web_fetch: missing url ---');
  console.log(await webFetch({}));

  console.log('\n--- web_search: missing query ---');
  console.log(await webSearch({}));
}

run().catch(console.error);
