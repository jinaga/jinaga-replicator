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
        console.warn(`Invalid URL scheme for ${envVar}: ${url}`);
      } else {
        upstreamReplicators.push(url);
      }
    } catch (error) {
      console.warn(`Invalid URL for ${envVar}: ${url}`);
    }

    index++;
  }

  return upstreamReplicators;
}
