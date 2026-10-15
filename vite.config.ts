import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports are allocated centrally in C:\Claude\PORTS.md - do not change them without updating it.
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to loopback only. The backend trusts Tailscale identity headers, so the only way in
    // from another device must be `tailscale serve`, which connects from this machine.
    host: "127.0.0.1",
    port: 5182,
    // Fail loudly instead of sliding to another port, which would leave start.bat and stop.bat
    // killing the wrong port.
    strictPort: true,
    // `tailscale serve` forwards the tailnet hostname as the Host header.
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": "http://127.0.0.1:4313",
    },
  },
});
