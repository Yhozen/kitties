export {};

if (process.argv.includes("--perception")) {
  const { servePerception } = await import("./perception.ts");
  await servePerception();
} else {
  await import("./channel.ts");
}
