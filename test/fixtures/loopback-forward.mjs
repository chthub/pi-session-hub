// Simulate VS Code/SSH forwarding to a different local port, preserving Host.
import http from "node:http";
export async function forwardLoopback(url) {
  const target = new URL(url);
  const server = http.createServer((req, res) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", error => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(error.message);
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/${target.hash}`,
    close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      return closed;
    },
  };
}
