import { Trace } from "jinaga";

export function findUpstreamReplicators(): string[] {
  const upstreamReplicators: string[] = [];
  let index = 1;

  while (true) {
    const envVar = `REPLICATOR_UPSTREAM_${index}`;
    const url = process.env[envVar];

    if (!url) {
      break;
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        Trace.warn(`Invalid URL scheme for ${envVar}: ${url}`);
      } else {
        upstreamReplicators.push(url);
      }
    } catch (error) {
      Trace.warn(`Invalid URL for ${envVar}: ${url}`);
    }

    index++;
  }

  if (upstreamReplicators.length > 0) {
    Trace.info('Detected upstream replicators:');
    upstreamReplicators.forEach((url, i) => {
      Trace.info(`${i + 1}. ${url}`);
    });
  } else {
    Trace.info('No upstream replicators detected.');
  }

  return upstreamReplicators;
}
