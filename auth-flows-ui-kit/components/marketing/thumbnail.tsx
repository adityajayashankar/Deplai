export function Thumbnail() {
  return (
    <div className="relative w-[1200px] h-[630px] bg-background overflow-hidden flex items-center justify-center">
      {/* Scattered mini UI pieces - behind the text */}

      {/* Login card - top left */}
      <div className="absolute top-12 left-16 w-[200px] rounded-lg border border-border bg-card p-3 space-y-2 rotate-[-4deg] opacity-70">
        <span className="text-[10px] font-mono text-foreground font-medium">Welcome back</span>
        <div className="space-y-1.5">
          <div className="h-6 w-full rounded border border-border bg-input flex items-center px-2">
            <span className="text-[8px] font-mono text-muted-foreground">john@example.com</span>
          </div>
          <div className="h-6 w-full rounded border border-border bg-input flex items-center px-2">
            <span className="text-[8px] font-mono text-muted-foreground tracking-widest">{"........"}</span>
          </div>
          <div className="h-5 w-full rounded bg-foreground flex items-center justify-center">
            <span className="text-[7px] font-mono text-background font-medium">Sign in</span>
          </div>
        </div>
      </div>

      {/* Signup card - top right */}
      <div className="absolute top-8 right-20 w-[210px] rounded-lg border border-border bg-card p-3 space-y-2 rotate-[3deg] opacity-70">
        <span className="text-[10px] font-mono text-foreground font-medium">Create account</span>
        <div className="grid grid-cols-2 gap-1">
          <div className="h-5 rounded border border-border bg-input flex items-center px-1.5">
            <span className="text-[7px] font-mono text-muted-foreground">John</span>
          </div>
          <div className="h-5 rounded border border-border bg-input flex items-center px-1.5">
            <span className="text-[7px] font-mono text-muted-foreground">Doe</span>
          </div>
        </div>
        <div className="h-5 w-full rounded border border-border bg-input flex items-center px-1.5">
          <span className="text-[7px] font-mono text-muted-foreground">john@example.com</span>
        </div>
        <div className="h-5 w-full rounded bg-foreground flex items-center justify-center">
          <span className="text-[7px] font-mono text-background font-medium">Create account</span>
        </div>
      </div>

      {/* OAuth buttons - bottom left */}
      <div className="absolute bottom-16 left-20 w-[180px] rounded-lg border border-border bg-card p-3 space-y-1.5 rotate-[2deg] opacity-70">
        <div className="h-6 w-full rounded border border-border bg-input flex items-center justify-center gap-1.5">
          <svg className="h-3 w-3" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          <span className="text-[8px] font-mono">Continue with Google</span>
        </div>
        <div className="h-6 w-full rounded border border-border bg-input flex items-center justify-center gap-1.5">
          <svg className="h-3 w-3 fill-foreground" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          <span className="text-[8px] font-mono">Continue with GitHub</span>
        </div>
      </div>

      {/* Password strength - mid right */}
      <div className="absolute bottom-24 right-16 w-[170px] rounded-lg border border-border bg-card p-3 space-y-1.5 rotate-[-3deg] opacity-70">
        <span className="text-[9px] font-mono text-foreground font-medium">Password strength</span>
        <div className="flex gap-0.5">
          {[true, true, true, false].map((active, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${active ? "bg-emerald-500" : "bg-input"}`} />
          ))}
        </div>
        <span className="text-[8px] font-mono text-emerald-500">Good</span>
      </div>

      {/* Success badge - mid left */}
      <div className="absolute top-1/2 -translate-y-1/2 left-8 flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 rotate-[-6deg] opacity-70">
        <div className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <svg className="h-2.5 w-2.5 text-emerald-500" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="text-[9px] font-mono text-emerald-500 font-medium">Account created</span>
      </div>

      {/* Error badge - bottom center-right */}
      <div className="absolute bottom-12 right-1/3 flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 rotate-[2deg] opacity-60">
        <div className="w-2 h-2 rounded-full bg-destructive" />
        <span className="text-[8px] font-mono text-destructive">Email is required</span>
      </div>

      {/* Giant AUTH text - on top */}
      <div className="relative z-10 select-none pointer-events-none">
        <h1
          className="font-mono font-black tracking-tighter text-foreground leading-none"
          style={{
            fontSize: "220px",
            textShadow: "0 0 80px rgba(0,0,0,0.9), 0 0 40px rgba(0,0,0,0.8)",
          }}
        >
          AUTH
        </h1>
      </div>

      {/* Subtle bottom label */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
        <span className="text-xs font-mono tracking-widest uppercase text-muted-foreground">Template</span>
      </div>
    </div>
  )
}
