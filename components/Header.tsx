"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MoonIcon, ShieldIcon, SunIcon } from "./Icons";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ss-theme", next); } catch { /* storage unavailable */ }
  }
  return (
    <button className="theme-toggle" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title="Toggle light / dark">
      <span className="theme-knob">{theme === "dark" ? <MoonIcon /> : <SunIcon />}</span>
    </button>
  );
}

export function Header() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="ShareSafe home">
        <span className="brand-mark"><ShieldIcon /></span>
        <span>ShareSafe</span>
      </Link>
      <ThemeToggle />
    </header>
  );
}
