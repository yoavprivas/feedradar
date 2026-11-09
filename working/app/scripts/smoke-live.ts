import { Collector } from "../server/collector.ts";
import { CollectorHttp, createTransport } from "../server/network.ts";
import { errorCode } from "../server/types.ts";
const collector = new Collector(new CollectorHttp(createTransport(12000)));
for (const url of [
  "https://www.ynet.co.il",
  "https://www.calcalist.co.il",
  "https://www.sport5.co.il",
  "https://www.google.com/finance/",
]) {
  const start = Date.now();
  try {
    const result = await collector.discover(url);
    console.log(
      JSON.stringify({
        url,
        name: result.name,
        method: result.method,
        endpoint: result.collectionUrl,
        articles: result.entries.length,
        dated: result.entries.filter((x) => x.publishedAt).length,
        seconds: (Date.now() - start) / 1000,
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        url,
        error: errorCode(e),
        seconds: (Date.now() - start) / 1000,
      }),
    );
  }
}
