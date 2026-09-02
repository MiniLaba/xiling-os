import process from "node:process";

const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error("XiLing Core must run as an Electron utility process");
}

parentPort.postMessage({
  type: "core-ready",
  protocolVersion: 1,
  startedAt: new Date().toISOString(),
});

parentPort.on("message", (event) => {
  const message = event.data as { type?: string } | undefined;
  if (message?.type === "shutdown") {
    parentPort.postMessage({ type: "core-stopped" });
    process.exit(0);
  }
});
