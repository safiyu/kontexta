"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatedLogo } from "@/components/layout/animated-logo";

export function LoginClient({ isSetupRequired }: { isSetupRequired: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [bypassIps, setBypassIps] = useState("127.0.0.1, localhost");
  const [trustProxyHeaders, setTrustProxyHeaders] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const endpoint = isSetupRequired ? "/api/auth/setup" : "/api/auth/login";
      const payload = isSetupRequired ? { password, bypassIps, trustProxyHeaders } : { password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      // Use router.push for clean navigation.
      // After first-time setup, include ?setup=1 so the Configure modal opens.
      router.push(isSetupRequired ? "/?setup=1" : "/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
        
        <div className="p-8 pb-6 text-center border-b border-[var(--border)] bg-gradient-to-b from-[var(--bg-tertiary)] to-transparent">
          <div className="flex justify-center mb-6">
            <AnimatedLogo size="sm" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--accent)] mb-2 tracking-wide font-[family-name:var(--font-title)]">
            {isSetupRequired ? "Secure Kontexta" : "Welcome Back"}
          </h1>
          <p className="text-[var(--text-secondary)] text-sm">
            {isSetupRequired 
              ? "Set a master password to protect your knowledge base from unauthorized network access."
              : "Enter your master password to access your knowledge base."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm text-center">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wider">
              Master Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-3 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] transition-all"
              required
              minLength={4}
              autoFocus
            />
          </div>

          {isSetupRequired && (
            <div className="space-y-2">
              <label className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                Bypass Authentication For (IPs)
              </label>
              <input
                type="text"
                value={bypassIps}
                onChange={(e) => setBypassIps(e.target.value)}
                placeholder="127.0.0.1, localhost"
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-3 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] transition-all text-sm font-mono"
              />
              <p className="text-xs text-[var(--text-tertiary)] mt-1">
                Comma-separated list of IPs. Leave "127.0.0.1, localhost" to skip login when accessing from the same machine.
              </p>

              <label className="flex items-start gap-2 mt-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={trustProxyHeaders}
                  onChange={(e) => setTrustProxyHeaders(e.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--text-secondary)] leading-snug">
                  Trust <code className="font-mono">X-Forwarded-For</code> headers
                  <span className="block text-[var(--text-tertiary)] mt-0.5">
                    Only enable this if Kontexta sits behind a reverse proxy you control (nginx, Caddy, Cloudflare Tunnel). Without a proxy, any caller on the network can spoof these headers and bypass auth.
                  </span>
                </span>
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[var(--accent)] text-black font-bold rounded-lg px-4 py-3 hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(180,120,30,0.3)]"
          >
            {loading ? (
              <svg className="animate-spin h-5 w-5 text-black" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              isSetupRequired ? "Initialize Security" : "Unlock"
            )}
          </button>
        </form>
      </div>
      
      <div className="mt-8 text-center text-xs text-[var(--text-tertiary)] font-mono">
        Kontexta Secure Enclave
      </div>
    </div>
  );
}
