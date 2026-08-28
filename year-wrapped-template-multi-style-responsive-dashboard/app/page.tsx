"use client"

import { Plus_Jakarta_Sans, Space_Grotesk } from "next/font/google"
import html2canvas from "html2canvas"
import { useRef, useState, useEffect } from "react"

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta",
})

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
})

export default function Page() {
  const contentRef = useRef<HTMLDivElement>(null)
  const [template, setTemplate] = useState<"modern" | "retro" | "genz" | "90s">("modern")
  const [showScrollTop, setShowScrollTop] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 300)
    }

    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const captureScreenshot = async () => {
    if (!contentRef.current) return null

    try {
      console.log("[v0] Starting screenshot capture...")

      const element = contentRef.current
      const clone = element.cloneNode(true) as HTMLElement

      // Add clone to document temporarily (hidden)
      clone.style.position = "absolute"
      clone.style.left = "-9999px"
      document.body.appendChild(clone)

      // Get all elements with computed styles and convert oklch to rgb
      const allElements = clone.querySelectorAll("*")
      allElements.forEach((el) => {
        const htmlEl = el as HTMLElement
        const computed = window.getComputedStyle(el)

        // Convert background color
        if (computed.backgroundColor && computed.backgroundColor.includes("oklch")) {
          htmlEl.style.backgroundColor = convertOklchToRgb(computed.backgroundColor)
        }

        // Convert text color
        if (computed.color && computed.color.includes("oklch")) {
          htmlEl.style.color = convertOklchToRgb(computed.color)
        }

        // Convert border color
        if (computed.borderColor && computed.borderColor.includes("oklch")) {
          htmlEl.style.borderColor = convertOklchToRgb(computed.borderColor)
        }
      })

      const canvas = await html2canvas(clone, {
        backgroundColor: "#050505",
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        width: clone.scrollWidth,
        height: clone.scrollHeight,
      })

      // Remove clone
      document.body.removeChild(clone)
      console.log("[v0] Screenshot captured successfully")

      return new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => {
          resolve(blob)
        }, "image/png")
      })
    } catch (error) {
      console.error("[v0] Error capturing screenshot:", error)
      return null
    }
  }

  const convertOklchToRgb = (oklchString: string): string => {
    const colorMap: Record<string, string> = {
      "oklch(1 0 0)": "rgb(255, 255, 255)",
      "oklch(0.145 0 0)": "rgb(37, 37, 37)",
      "oklch(0.97 0 0)": "rgb(247, 247, 247)",
      "oklch(0.205 0 0)": "rgb(52, 52, 52)",
      "oklch(0.985 0 0)": "rgb(251, 251, 251)",
      "oklch(0.922 0 0)": "rgb(235, 235, 235)",
      "oklch(0.269 0 0)": "rgb(69, 69, 69)",
      "oklch(0.708 0 0)": "rgb(180, 180, 180)",
      "oklch(0.556 0 0)": "rgb(142, 142, 142)",
      "oklch(0.439 0 0)": "rgb(112, 112, 112)",
    }

    for (const [oklch, rgb] of Object.entries(colorMap)) {
      if (oklchString.includes(oklch)) {
        return rgb
      }
    }

    return "rgb(0, 0, 0)"
  }

  const handleDownloadImage = async () => {
    console.log("[v0] Download Image clicked")
    const blob = await captureScreenshot()
    if (!blob) {
      alert("Failed to capture image. Please try again.")
      return
    }

    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.download = "jess-2025-wrapped.png"
    link.href = url
    link.click()
    URL.revokeObjectURL(url)
    console.log("[v0] Image downloaded successfully")
  }

  const handleShareOnX = async () => {
    console.log("[v0] Share on X clicked")
    const blob = await captureScreenshot()
    if (!blob) {
      alert("Failed to capture image. Please try again.")
      return
    }

    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], "jess-2025-wrapped.png", {
          type: "image/png",
        })

        const shareData = {
          title: "My 2025 Wrapped",
          text: "Check out my 2025 Wrapped from 1UI.dev!",
          files: [file],
        }

        if (navigator.canShare(shareData)) {
          console.log("[v0] Using Web Share API with image")
          await navigator.share(shareData)
          return
        }
      } catch (error) {
        console.error("[v0] Web Share API error:", error)
      }
    }

    console.log("[v0] Using fallback: download + Twitter intent")
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.download = "jess-2025-wrapped.png"
    link.href = url
    link.click()
    URL.revokeObjectURL(url)

    setTimeout(() => {
      const text = encodeURIComponent("Check out my 2025 Wrapped from 1UI.dev!")
      const shareUrl = `https://twitter.com/intent/tweet?text=${text}`
      window.open(shareUrl, "_blank", "width=550,height=420")
    }, 500)
  }

  return (
    <div className={`${plusJakarta.variable} ${spaceGrotesk.variable} font-[family-name:var(--font-plus-jakarta)]`}>
      <div
        className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-nowrap gap-1 md:gap-2 ${template === "retro" ? "text-black" : "text-white"}`}
      >
        <button
          onClick={() => setTemplate("modern")}
          className={`px-2 py-1.5 md:px-4 md:py-2 rounded-full text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${
            template === "modern"
              ? "bg-white text-black"
              : template === "retro"
                ? "bg-black/10 text-black"
                : template === "90s"
                  ? "bg-yellow-400/20 text-black"
                  : "bg-white/10 text-white backdrop-blur-sm"
          }`}
        >
          Modern
        </button>
        <button
          onClick={() => setTemplate("retro")}
          className={`px-2 py-1.5 md:px-4 md:py-2 rounded-full text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${
            template === "retro"
              ? "bg-black text-white"
              : template === "modern"
                ? "bg-white/10 text-white"
                : template === "genz"
                  ? "bg-white/10 text-white backdrop-blur-sm"
                  : template === "90s"
                    ? "bg-yellow-400/20 text-black"
                    : "bg-white text-black"
          }`}
        >
          Retro
        </button>
        <button
          onClick={() => setTemplate("genz")}
          className={`px-2 py-1.5 md:px-4 md:py-2 rounded-full text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${
            template === "genz"
              ? "bg-white text-black"
              : template === "retro"
                ? "bg-black/10 text-black"
                : template === "90s"
                  ? "bg-yellow-400/20 text-black"
                  : "bg-white/10 text-white backdrop-blur-sm"
          }`}
        >
          Gen Z
        </button>
        <button
          onClick={() => setTemplate("90s")}
          className={`px-2 py-1.5 md:px-4 md:py-2 rounded-full text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${
            template === "90s"
              ? "bg-[#00ff00] text-black border-2 border-black"
              : template === "retro"
                ? "bg-black/10 text-black"
                : "bg-white/10 text-white backdrop-blur-sm"
          }`}
        >
          90s
        </button>
      </div>

      {showScrollTop && (
        <button
          onClick={scrollToTop}
          className={`fixed bottom-8 right-8 z-50 p-4 rounded-full transition-all shadow-lg hover:scale-110 ${
            template === "modern"
              ? "bg-white text-black hover:bg-[#00d4ff]"
              : template === "retro"
                ? "bg-black text-white border-4 border-white shadow-[8px_8px_0px_0px_rgba(255,255,255,1)]"
                : template === "genz"
                  ? "bg-gradient-to-r from-[#ff6ec4] to-[#7873f5] text-white shadow-[0_0_20px_rgba(255,110,196,0.5)]"
                  : "bg-[#ff00ff] text-[#00ff00] border-4 border-[#00ff00] shadow-[6px_6px_0px_0px_#00ff00]"
          }`}
          aria-label="Scroll to top"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
          >
            <path d="M18 15l-6-6-6 6"></path>
          </svg>
        </button>
      )}

      {template === "modern" ? (
        <div className="min-h-screen bg-[#050505] text-white flex justify-center px-4 sm:px-6 lg:px-8 py-6 sm:py-10 lg:py-10">
          <style jsx global>{`
            body {
              background-image: radial-gradient(circle at 10% 20%, rgba(121, 40, 202, 0.08) 0%, transparent 40%), 
                                radial-gradient(circle at 90% 80%, rgba(204, 243, 129, 0.05) 0%, transparent 40%);
            }
          `}</style>

          <div ref={contentRef} className="w-full max-w-[1200px] flex flex-col gap-6">
            <header className="flex justify-between items-center py-4 sm:py-5 mb-4 sm:mb-5">
              <div className="flex items-center gap-2">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#ccf381"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-6 h-6"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <path d="M9 3v18"></path>
                  <path d="M15 9h-6"></path>
                </svg>
                <div className="font-[family-name:var(--font-space-grotesk)] font-bold text-xl sm:text-2xl tracking-tight">
                  1UI<span className="text-[#ccf381]">.dev</span>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 bg-[#121212] border border-[#262626] py-1 px-3 sm:px-4 rounded-full text-sm font-medium">
                <img
                  src="/images/jessin.png"
                  alt="User"
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-full object-cover border-2 border-[#050505]"
                />
                <span className="hidden sm:inline">Jess's 2025</span>
                <span className="sm:hidden">Jess</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M6 9l6 6 6-6"></path>
                </svg>
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-auto gap-4 sm:gap-6">
              <div className="md:col-span-2 bg-black rounded-[32px] p-6 sm:p-8 relative overflow-hidden flex flex-col justify-end min-h-[380px] border border-[#262626] transition-all hover:border-[#404040] hover:-translate-y-0.5">
                <img
                  src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1200&auto=format&fit=crop&ixlib=rb-4.0.3"
                  alt="Abstract fluid"
                  className="absolute top-0 left-0 w-full h-full object-cover opacity-60 mix-blend-lighten"
                />
                <div className="relative z-10">
                  <div className="text-xl sm:text-2xl text-[#ccf381] mb-2 font-medium">Your Year Wrapped</div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-7xl sm:text-8xl lg:text-[120px] font-bold leading-[0.8] tracking-tighter text-white -ml-1 sm:-ml-1.5">
                    2025
                  </div>
                  <div className="mt-6 bg-white/10 backdrop-blur-md border-t border-white/20 p-4 sm:p-5 rounded-2xl">
                    <p className="text-sm sm:text-base font-medium opacity-90">
                      You're in the top 1% of UI creators this year. You didn't just design; you shipped.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-b from-[#1a1a1a] to-[#121212] rounded-[32px] p-6 sm:p-8 flex flex-col justify-between min-h-[380px] border border-[#262626] transition-all hover:border-[#404040] hover:-translate-y-0.5">
                <div>
                  <div className="text-xs sm:text-sm text-[#a1a1aa] uppercase tracking-wider font-semibold mb-2">
                    Total Components Used
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-5xl sm:text-6xl font-bold leading-none mb-0 bg-gradient-to-br from-[#7928ca] to-[#ff0080] bg-clip-text text-transparent">
                    1,492
                  </div>
                </div>

                <div className="mt-8">
                  <div className="text-xs sm:text-sm text-[#a1a1aa] uppercase tracking-wider font-semibold mb-2">
                    Lines of Code Copied
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl font-bold leading-none text-white mb-3">
                    84.5k
                  </div>
                  <div className="inline-flex items-center gap-1 bg-[#ccf381]/10 text-[#ccf381] px-3 py-1 rounded-full text-xs font-semibold">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-3 h-3">
                      <path d="M18 15l-6-6-6 6"></path>
                    </svg>
                    +240% vs 2024
                  </div>
                </div>
              </div>

              <div className="bg-white text-black rounded-[32px] p-6 sm:p-8 flex flex-col justify-between min-h-[320px] sm:min-h-[380px] border border-[#262626] transition-all hover:border-[#404040] hover:-translate-y-0.5">
                <div className="flex justify-between items-start mb-6">
                  <span className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-bold">Design Persona</span>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                    <circle cx="12" cy="12" r="2"></circle>
                    <circle cx="19" cy="12" r="2"></circle>
                    <circle cx="5" cy="12" r="2"></circle>
                  </svg>
                </div>

                <div className="text-center flex-1 flex flex-col justify-center">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 bg-black rounded-full flex items-center justify-center mx-auto mb-6">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-10 h-10 sm:w-12 sm:h-12"
                    >
                      <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                      <polyline points="2 17 12 22 22 17"></polyline>
                      <polyline points="2 12 12 17 22 12"></polyline>
                    </svg>
                  </div>
                  <div className="text-sm font-semibold uppercase mb-2 opacity-60 tracking-wide">You are a</div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[36px] font-bold leading-tight tracking-tight mb-6">
                    System
                    <br />
                    Architect
                  </div>
                </div>

                <div className="text-sm leading-relaxed font-medium border-t border-black/10 pt-5">
                  Consistency is your currency. You love atomic design and reusable tokens.
                </div>
              </div>

              <div className="md:col-span-2 lg:col-span-2 bg-gradient-to-br from-[#1a1a1a] to-[#121212] rounded-[32px] p-6 sm:p-8 border border-[#262626] transition-all hover:border-[#404040] hover:-translate-y-0.5">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-xl sm:text-2xl font-bold">
                    Top Tech Stack
                  </h3>
                  <span className="text-sm text-[#a1a1aa]">Based on exports</span>
                </div>

                <div className="space-y-5">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-[#61DAFB]/10 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 24 24" fill="#61DAFB" className="w-6 h-6">
                        <circle cx="12" cy="12" r="10"></circle>
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between mb-1">
                        <span className="font-semibold text-white">React</span>
                        <span className="text-xs font-semibold text-white">68%</span>
                      </div>
                      <div className="h-2 bg-[#262626] rounded-full overflow-hidden">
                        <div className="h-full bg-[#61DAFB] rounded-full" style={{ width: "68%" }}></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-[#06B6D4]/10 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 24 24" fill="#06B6D4" className="w-6 h-6">
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between mb-1">
                        <span className="font-semibold text-white">Tailwind CSS</span>
                        <span className="text-xs font-semibold text-white">82%</span>
                      </div>
                      <div className="h-2 bg-[#262626] rounded-full overflow-hidden">
                        <div className="h-full bg-[#06B6D4] rounded-full" style={{ width: "82%" }}></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-[#3178C6]/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-bold text-[#3178C6] font-mono text-sm">TS</span>
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between mb-1">
                        <span className="font-semibold text-white">TypeScript</span>
                        <span className="text-xs font-semibold text-white">54%</span>
                      </div>
                      <div className="h-2 bg-[#262626] rounded-full overflow-hidden">
                        <div className="h-full bg-[#3178C6] rounded-full" style={{ width: "54%" }}></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="relative bg-gradient-to-br from-[#FF6B35] to-[#F7931E] rounded-[32px] p-6 sm:p-8 overflow-hidden flex flex-col justify-between min-h-[320px] sm:min-h-[380px] border border-[#262626] transition-all hover:-translate-y-0.5">
                <img
                  src="https://images.unsplash.com/photo-1579546929518-9e396f3cc809?q=80&w=600&auto=format&fit=crop"
                  alt="Texture"
                  className="absolute top-0 left-0 w-full h-full object-cover mix-blend-overlay opacity-50"
                />
                <div className="relative z-10">
                  <div className="font-bold text-sm uppercase mb-1 text-black">Top Category</div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-4xl font-bold text-black">
                    Dashboards
                  </div>
                </div>

                <div className="relative z-10">
                  <div className="font-semibold text-sm mb-3 text-black">Favorite Palette</div>
                  <div className="flex gap-2">
                    <div className="w-12 h-12 rounded-full bg-black border-2 border-black"></div>
                    <div className="w-12 h-12 rounded-full bg-[#7928ca] border-2 border-black"></div>
                    <div className="w-12 h-12 rounded-full bg-[#ccf381] border-2 border-black"></div>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#1a1a1a] to-[#0a0a0a] rounded-[32px] p-6 sm:p-8 border border-[#262626] transition-all hover:border-[#404040] hover:-translate-y-0.5">
                <div className="text-xs sm:text-sm text-[#a1a1aa] uppercase tracking-wider font-semibold mb-2">
                  Peak Productivity
                </div>
                <div className="text-2xl sm:text-[28px] font-bold text-white mb-1">Tuesday, 10 PM</div>
                <div className="text-sm text-[#a1a1aa] mb-6">You are a night owl.</div>

                <div className="grid grid-cols-7 gap-1.5">
                  {[
                    1, 2, 1, 3, 2, 1, 1, 2, 3, 3, 3, 3, 2, 1, 1, 2, 3, 2, 1, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 2, 2, 3, 2,
                    1, 2,
                  ].map((level, i) => (
                    <div
                      key={i}
                      className={`aspect-square rounded ${
                        level === 1 ? "bg-[#262626]" : level === 2 ? "bg-[#7928ca]/40" : "bg-[#7928ca]"
                      }`}
                    ></div>
                  ))}
                </div>
              </div>

              <div className="md:col-span-2 lg:col-span-4 bg-gradient-to-r from-[#121212] to-[#1a1a1a] rounded-[32px] p-6 sm:p-8 lg:p-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 min-h-[200px] sm:min-h-[240px] border border-[#262626] transition-all hover:border-[#404040] hover:-translate-y-0.5">
                <div>
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-2xl sm:text-3xl font-bold mb-2">
                    Share your 2025 Wrapped
                  </h3>
                  <p className="text-[#a1a1aa] text-sm sm:text-base">Show the world what you've built with 1UI.dev</p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
                  <button
                    onClick={handleDownloadImage}
                    className="bg-transparent text-white border border-white/20 px-6 py-3 sm:py-4 rounded-full font-bold text-sm sm:text-base transition-transform hover:scale-105 whitespace-nowrap"
                  >
                    Download Image
                  </button>
                  <button
                    onClick={handleShareOnX}
                    className="bg-white text-black px-6 py-3 sm:py-4 rounded-full font-bold text-sm sm:text-base transition-all hover:scale-105 hover:bg-[#ccf381] flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    Share on
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : template === "retro" ? (
        <div className="min-h-screen bg-white text-black flex justify-center px-4 sm:px-6 lg:px-8 py-6 sm:py-10 lg:py-10">
          <div ref={contentRef} className="w-full max-w-[1200px] flex flex-col gap-6">
            <header className="flex justify-between items-center py-4 sm:py-5 mb-4 sm:mb-5 border-b-2 border-black">
              <div className="flex items-center gap-2">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="black"
                  strokeWidth="3"
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                  className="w-6 h-6"
                >
                  <rect x="3" y="3" width="18" height="18" rx="0" ry="0"></rect>
                  <path d="M9 3v18"></path>
                  <path d="M15 9h-6"></path>
                </svg>
                <div className="font-[family-name:var(--font-space-grotesk)] font-black text-xl sm:text-2xl tracking-tight">
                  1UI<span className="text-black">.dev</span>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 bg-white border-2 border-black py-1 px-3 sm:px-4 text-sm font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                <img
                  src="/images/jessin.png"
                  alt="User"
                  className="w-7 h-7 sm:w-8 sm:h-8 object-cover border-2 border-black"
                />
                <span className="hidden sm:inline">Jess's 2025</span>
                <span className="sm:hidden">Jess</span>
                <svg viewBox="0 0 24 24" fill="black" className="w-4 h-4">
                  <path d="M7 10l5 5 5-6z"></path>
                </svg>
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-auto gap-4 sm:gap-6">
              <div className="md:col-span-2 bg-white rounded-none p-6 sm:p-8 relative overflow-hidden flex flex-col justify-end min-h-[380px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div className="absolute top-0 left-0 w-full h-full">
                  <div
                    className="w-full h-full"
                    style={{
                      backgroundImage: `repeating-linear-gradient(
                      45deg,
                      transparent,
                      transparent 10px,
                      rgba(0,0,0,0.03) 10px,
                      rgba(0,0,0,0.03) 20px
                    )`,
                    }}
                  ></div>
                </div>
                <div className="relative z-10">
                  <div className="text-xl sm:text-2xl font-black mb-2 border-2 border-black inline-block px-3 py-1 bg-white">
                    Your Year Wrapped
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-7xl sm:text-8xl lg:text-[120px] font-black leading-[0.8] tracking-tighter text-black -ml-1 sm:-ml-1.5">
                    2025
                  </div>
                  <div className="mt-6 bg-white border-4 border-black p-4 sm:p-5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <p className="text-sm sm:text-base font-bold">
                      You're in the top 1% of UI creators this year. You didn't just design; you shipped.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-none p-6 sm:p-8 flex flex-col justify-between min-h-[380px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div>
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 border-b-2 border-black pb-1">
                    Total Components Used
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-5xl sm:text-6xl font-black leading-none mb-0 text-black">
                    1,492
                  </div>
                </div>

                <div className="mt-8">
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 border-b-2 border-black pb-1">
                    Lines of Code Copied
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl font-black leading-none text-black mb-3">
                    84.5k
                  </div>
                  <div className="inline-flex items-center gap-1 bg-black text-white px-3 py-1 text-xs font-black border-2 border-black">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-3 h-3">
                      <path d="M18 15l-6-6-6 6"></path>
                    </svg>
                    +240% vs 2024
                  </div>
                </div>
              </div>

              <div className="bg-white text-black rounded-none p-6 sm:p-8 flex flex-col justify-between min-h-[320px] sm:min-h-[380px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div className="flex justify-between items-start mb-6">
                  <span className="bg-black text-white px-5 py-2.5 text-sm font-black border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    Design Persona
                  </span>
                  <svg viewBox="0 0 24 24" fill="black" className="w-6 h-6">
                    <circle cx="5" cy="12" r="2"></circle>
                    <circle cx="12" cy="12" r="2"></circle>
                    <circle cx="19" cy="12" r="2"></circle>
                  </svg>
                </div>

                <div className="text-center flex-1 flex flex-col justify-center">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 bg-black flex items-center justify-center mx-auto mb-6 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2"
                      strokeLinecap="square"
                      strokeLinejoin="miter"
                      className="w-10 h-10 sm:w-12 sm:h-12"
                    >
                      <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                      <polyline points="2 17 12 22 22 17"></polyline>
                      <polyline points="2 12 12 17 22 12"></polyline>
                    </svg>
                  </div>
                  <div className="text-sm font-black uppercase mb-2 tracking-wide border-2 border-black inline-block px-2 py-1 mx-auto">
                    You are a
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[36px] font-black leading-tight tracking-tight mb-6">
                    System
                    <br />
                    Architect
                  </div>
                </div>

                <div className="text-sm leading-relaxed font-bold border-t-4 border-black pt-5">
                  Consistency is your currency. You love atomic design and reusable tokens.
                </div>
              </div>

              <div className="bg-white rounded-none p-6 sm:p-8 min-h-[320px] sm:min-h-[380px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div className="flex justify-between items-center mb-6 border-b-4 border-black pb-4">
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-xl sm:text-2xl font-black">
                    Top Tech Stack
                  </h3>
                  <span className="text-xs sm:text-sm font-black">Based on exports</span>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-4 p-3 bg-white rounded-none border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    <div className="w-10 h-10 bg-black flex items-center justify-center flex-shrink-0 border-2 border-black">
                      <span className="text-white font-black text-sm">R</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">React</div>
                        <div className="text-xs font-black">68%</div>
                      </div>
                      <div className="h-2 w-full bg-white border-2 border-black overflow-hidden">
                        <div className="h-full bg-black" style={{ width: "68%" }}></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-white rounded-none border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    <div className="w-10 h-10 bg-black flex items-center justify-center flex-shrink-0 border-2 border-black">
                      <span className="text-white font-black text-sm">T</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">Tailwind CSS</div>
                        <div className="text-xs font-black">82%</div>
                      </div>
                      <div className="h-2 w-full bg-white border-2 border-black overflow-hidden">
                        <div className="h-full bg-black" style={{ width: "82%" }}></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-white rounded-none border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                    <div className="w-10 h-10 bg-black flex items-center justify-center flex-shrink-0 border-2 border-black">
                      <span className="text-white font-black text-sm">TS</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">TypeScript</div>
                        <div className="text-xs font-black">54%</div>
                      </div>
                      <div className="h-2 w-full bg-white border-2 border-black overflow-hidden">
                        <div className="h-full bg-black" style={{ width: "54%" }}></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-none p-6 sm:p-8 relative overflow-hidden min-h-[320px] sm:min-h-[380px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div className="absolute top-0 left-0 w-full h-full opacity-10">
                  <div
                    className="w-full h-full"
                    style={{
                      backgroundImage: `repeating-linear-gradient(
                      0deg,
                      transparent,
                      transparent 20px,
                      rgba(0,0,0,0.1) 20px,
                      rgba(0,0,0,0.1) 21px
                    ), repeating-linear-gradient(
                      90deg,
                      transparent,
                      transparent 20px,
                      rgba(0,0,0,0.1) 20px,
                      rgba(0,0,0,0.1) 21px
                    )`,
                    }}
                  ></div>
                </div>
                <div className="relative z-10 h-full flex flex-col justify-between">
                  <div>
                    <div className="font-black text-xs sm:text-sm uppercase mb-1 border-2 border-black inline-block px-2 py-1">
                      Top Category
                    </div>
                    <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[32px] font-black leading-none mt-4">
                      Dashboards
                    </div>
                  </div>

                  <div>
                    <div className="font-black text-sm mb-3 border-b-2 border-black pb-2">Favorite Palette</div>
                    <div className="flex gap-2">
                      <div className="w-12 h-12 border-4 border-black bg-black"></div>
                      <div className="w-12 h-12 border-4 border-black bg-white"></div>
                      <div className="w-12 h-12 border-4 border-black bg-black"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-none p-5 sm:p-6 min-h-[320px] sm:min-h-[380px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-col">
                <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 border-b-2 border-black pb-2">
                  Peak Productivity
                </div>
                <div className="text-2xl sm:text-[28px] font-black text-black mb-1">Tuesday, 10 PM</div>
                <div className="text-sm font-bold mb-5">You are a night owl.</div>

                <div className="grid grid-cols-7 gap-1.5 mt-auto">
                  {[...Array(28)].map((_, i) => {
                    const isActive = [1, 3, 4, 7, 8, 9, 10, 11, 14, 15, 18, 22, 25, 26].includes(i)
                    return (
                      <div
                        key={i}
                        className={`aspect-square border-2 border-black ${isActive ? "bg-black" : "bg-white"}`}
                      ></div>
                    )
                  })}
                </div>
              </div>

              <div className="md:col-span-2 lg:col-span-4 bg-white rounded-none p-6 sm:p-8 lg:p-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 min-h-[200px] sm:min-h-[240px] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div>
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-2xl sm:text-3xl font-black mb-2">
                    Share your 2025 Wrapped
                  </h3>
                  <p className="text-black font-bold text-sm sm:text-base">
                    Show the world what you've built with 1UI.dev
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
                  <button
                    onClick={handleDownloadImage}
                    className="bg-white text-black border-4 border-black px-6 py-3 sm:py-4 font-black text-sm sm:text-base transition-transform hover:translate-x-1 hover:translate-y-1 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none whitespace-nowrap"
                  >
                    Download Image
                  </button>
                  <button
                    onClick={handleShareOnX}
                    className="bg-black text-white px-6 py-3 sm:py-4 font-black text-sm sm:text-base transition-transform hover:translate-x-1 hover:translate-y-1 flex items-center justify-center gap-2 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none whitespace-nowrap"
                  >
                    Share on
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : template === "genz" ? (
        <div className="min-h-screen bg-gradient-to-br from-[#ff6ec4] via-[#7873f5] to-[#4facfe] text-white flex justify-center px-4 sm:px-6 lg:px-8 py-6 sm:py-10 lg:py-10">
          <style jsx global>{`
            @keyframes float {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(-20px); }
            }
            .float-animation {
              animation: float 6s ease-in-out infinite;
            }
          `}</style>

          <div ref={contentRef} className="w-full max-w-[1200px] flex flex-col gap-6">
            <header className="flex justify-between items-center py-4 sm:py-5 mb-4 sm:mb-5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-5 h-5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <path d="M9 3v18"></path>
                    <path d="M15 9h-6"></path>
                  </svg>
                </div>
                <div className="font-[family-name:var(--font-space-grotesk)] font-bold text-xl sm:text-2xl tracking-tight">
                  1UI<span className="text-[#ffeb3b]">.dev</span>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 bg-white/20 backdrop-blur-lg border border-white/30 py-1 px-3 sm:px-4 rounded-full text-sm font-medium shadow-lg">
                <img
                  src="/images/jessin.png"
                  alt="User"
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-full object-cover border-2 border-white/50"
                />
                <span className="hidden sm:inline">Jess's 2025</span>
                <span className="sm:hidden">Jess</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M6 9l6 6 6-6"></path>
                </svg>
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-auto gap-4 sm:gap-6">
              <div className="md:col-span-2 bg-gradient-to-br from-[#667eea] via-[#764ba2] to-[#f093fb] rounded-[32px] p-6 sm:p-10 relative overflow-hidden flex flex-col justify-between min-h-[380px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="absolute top-0 left-0 w-full h-full opacity-30">
                  <div className="absolute top-10 left-10 w-32 h-32 rounded-full bg-white/40 blur-3xl"></div>
                  <div className="absolute bottom-10 right-10 w-40 h-40 rounded-full bg-[#ffeb3b]/40 blur-3xl"></div>
                </div>
                <div className="relative z-10 flex flex-col justify-end h-full">
                  <div className="inline-flex items-center gap-2 text-lg sm:text-xl font-black mb-6 bg-white/20 backdrop-blur-md px-5 py-3 rounded-full border border-white/40 self-start shadow-lg">
                    <span className="text-2xl">✨</span>
                    <span>Your Year Wrapped</span>
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-8xl sm:text-[100px] lg:text-[140px] font-black leading-[0.85] tracking-tighter text-white [text-shadow:_5px_5px_0_rgb(0_0_0_/_20%)] mb-6">
                    2025
                  </div>
                  <div className="bg-white/20 backdrop-blur-xl border-2 border-white/30 p-5 sm:p-6 rounded-3xl shadow-xl">
                    <p className="text-base sm:text-lg font-black leading-relaxed">
                      You're in the top 1% of UI creators this year. You didn't just design; you shipped. 🚀
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#fa709a] to-[#fee140] text-black rounded-[32px] p-6 sm:p-8 flex flex-col justify-between min-h-[380px] border-2 border-white/50 shadow-2xl transition-all hover:scale-[1.02]">
                <div>
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 opacity-80">
                    Total Components Used
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-5xl sm:text-6xl font-black leading-none mb-0 [text-shadow:_3px_3px_0_rgb(255_255_255_/_50%)]">
                    1,492
                  </div>
                </div>

                <div className="mt-8">
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 opacity-80">
                    Lines of Code Copied
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl font-black leading-none mb-3 [text-shadow:_3px_3px_0_rgb(255_255_255_/_50%)]">
                    84.5k
                  </div>
                  <div className="inline-flex items-center gap-1 bg-black/20 backdrop-blur-sm text-white px-3 py-1 rounded-full text-xs font-black border border-black/30">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-3 h-3">
                      <path d="M18 15l-6-6-6 6"></path>
                    </svg>
                    +240% vs 2024
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#a8edea] to-[#fed6e3] text-black rounded-[32px] p-6 sm:p-8 flex flex-col justify-between min-h-[320px] sm:min-h-[380px] border-2 border-white/50 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="flex justify-between items-start mb-6">
                  <span className="bg-gradient-to-r from-[#667eea] to-[#764ba2] text-white px-5 py-2.5 rounded-full text-sm font-black border-2 border-white/50 shadow-lg">
                    Design Persona 🎨
                  </span>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 opacity-50">
                    <circle cx="12" cy="12" r="2"></circle>
                    <circle cx="19" cy="12" r="2"></circle>
                    <circle cx="5" cy="12" r="2"></circle>
                  </svg>
                </div>

                <div className="text-center flex-1 flex flex-col justify-center">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-[#667eea] to-[#764ba2] rounded-full flex items-center justify-center mx-auto mb-6 shadow-2xl float-animation border-4 border-white/50">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-10 h-10 sm:w-12 sm:h-12"
                    >
                      <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                      <polyline points="2 17 12 22 22 17"></polyline>
                      <polyline points="2 12 12 17 22 12"></polyline>
                    </svg>
                  </div>
                  <div className="text-sm font-black uppercase mb-2 opacity-70 tracking-wide">You are a</div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[36px] font-black leading-tight tracking-tight mb-6 [text-shadow:_2px_2px_0_rgb(255_255_255_/_50%)]">
                    System
                    <br />
                    Architect
                  </div>
                </div>

                <div className="text-sm leading-relaxed font-bold bg-white/30 backdrop-blur-sm p-4 rounded-2xl border border-white/50">
                  Consistency is your currency. You love atomic design and reusable tokens. 💎
                </div>
              </div>

              <div className="md:col-span-2 bg-white/10 backdrop-blur-xl rounded-[32px] p-6 sm:p-8 min-h-[320px] sm:min-h-[380px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-xl sm:text-2xl font-black">
                    Top Tech Stack 💻
                  </h3>
                  <span className="text-xs sm:text-sm font-bold opacity-70">Based on exports</span>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-4 p-3 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#61DAFB] to-[#00D8FF] flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-black text-sm">R</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">React</div>
                        <div className="text-xs font-black">68%</div>
                      </div>
                      <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#61DAFB] to-[#00D8FF]"
                          style={{ width: "68%" }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#06B6D4] to-[#38bdf8] flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-black text-sm">T</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">Tailwind CSS</div>
                        <div className="text-xs font-black">82%</div>
                      </div>
                      <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#06B6D4] to-[#38bdf8]"
                          style={{ width: "82%" }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3178C6] to-[#5199d8] flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-black text-sm">TS</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">TypeScript</div>
                        <div className="text-xs font-black">54%</div>
                      </div>
                      <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#3178C6] to-[#5199d8]"
                          style={{ width: "54%" }}
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#f093fb] via-[#f5576c] to-[#ffd700] text-black rounded-[32px] p-6 sm:p-8 relative overflow-hidden min-h-[320px] sm:min-h-[380px] border-2 border-white/50 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="absolute top-0 left-0 w-full h-full opacity-20">
                  <div className="absolute top-5 right-5 w-24 h-24 rounded-full bg-white blur-2xl"></div>
                  <div className="absolute bottom-5 left-5 w-32 h-32 rounded-full bg-[#ffeb3b] blur-2xl"></div>
                </div>
                <div className="relative z-10 h-full flex flex-col justify-between">
                  <div>
                    <div className="font-black text-xs sm:text-sm uppercase mb-1 bg-white/30 backdrop-blur-sm inline-block px-3 py-1 rounded-full">
                      Top Category 🏆
                    </div>
                    <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[32px] font-black leading-none mt-4 [text-shadow:_3px_3px_0_rgb(255_255_255_/_50%)]">
                      Dashboards
                    </div>
                  </div>

                  <div>
                    <div className="font-black text-sm mb-3">Favorite Palette 🎨</div>
                    <div className="flex gap-2">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#667eea] to-[#764ba2] border-2 border-white/50 shadow-lg"></div>
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#f093fb] to-[#f5576c] border-2 border-white/50 shadow-lg"></div>
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#ffd700] to-[#ffeb3b] border-2 border-white/50 shadow-lg"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white/10 backdrop-blur-xl rounded-[32px] p-5 sm:p-6 min-h-[320px] sm:min-h-[380px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02] flex flex-col">
                <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 opacity-70">
                  Peak Productivity 🌙
                </div>
                <div className="text-2xl sm:text-[28px] font-black text-white mb-1">Tuesday, 10 PM</div>
                <div className="text-sm font-bold mb-5 opacity-80">You are a night owl.</div>

                <div className="grid grid-cols-7 gap-1.5 mt-auto">
                  {[...Array(28)].map((_, i) => {
                    const isActive = [1, 3, 4, 7, 8, 9, 10, 11, 14, 15, 18, 22, 25, 26].includes(i)
                    return (
                      <div
                        key={i}
                        className={`aspect-square rounded-lg transition-all ${isActive ? "bg-gradient-to-br from-[#f093fb] to-[#f5576c] shadow-lg" : "bg-white/20"}`}
                      ></div>
                    )
                  })}
                </div>
              </div>

              <div className="md:col-span-2 lg:col-span-4 bg-white/10 backdrop-blur-xl rounded-[32px] p-6 sm:p-8 lg:p-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 min-h-[200px] sm:min-h-[240px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02]">
                <div>
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-2xl sm:text-3xl font-black mb-2">
                    Share your 2025 Wrapped ✨
                  </h3>
                  <p className="text-white/80 text-sm sm:text-base font-bold">
                    Show the world what you've built with 1UI.dev 🚀
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
                  <button
                    onClick={handleDownloadImage}
                    className="bg-white/20 backdrop-blur-md text-white border-2 border-white/30 px-6 py-3 sm:py-4 rounded-full font-black text-sm sm:text-base transition-all hover:scale-105 hover:bg-white/30 shadow-lg whitespace-nowrap"
                  >
                    Download Image
                  </button>
                  <button
                    onClick={handleShareOnX}
                    className="bg-white text-black px-6 py-3 sm:py-4 rounded-full font-black text-sm sm:text-base transition-all hover:scale-105 hover:bg-[#ffeb3b] flex items-center justify-center gap-2 shadow-xl whitespace-nowrap"
                  >
                    Share on
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : template === "90s" ? (
        <div className="min-h-screen bg-[#00ffff] text-black flex justify-center px-4 sm:px-6 lg:px-8 py-6 sm:py-10 lg:py-10 relative overflow-hidden">
          {/* 90s Background Pattern */}
          <div className="absolute inset-0 opacity-30 pointer-events-none">
            <div className="absolute top-10 left-10 w-32 h-32 border-8 border-[#ff00ff] rotate-45"></div>
            <div className="absolute top-40 right-20 w-24 h-24 border-8 border-[#00ff00] rounded-full"></div>
            <div className="absolute bottom-20 left-32 w-40 h-40 border-8 border-[#ffff00]"></div>
            <div className="absolute bottom-40 right-40 w-20 h-20 bg-[#ff00ff]"></div>
            <svg className="absolute top-20 right-10 w-32 h-32" viewBox="0 0 100 100">
              <path d="M 10 50 Q 30 10 50 50 T 90 50" stroke="#ff00ff" strokeWidth="6" fill="none" />
            </svg>
            <svg className="absolute bottom-32 left-20 w-40 h-40" viewBox="0 0 100 100">
              <path d="M 20 80 L 40 20 L 60 80 L 80 20" stroke="#00ff00" strokeWidth="6" fill="none" />
            </svg>
          </div>

          <div ref={contentRef} className="w-full max-w-[1200px] flex flex-col gap-6 relative z-10">
            <header className="flex justify-between items-center py-4 sm:py-5 mb-4 sm:mb-5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-[#ff00ff] border-4 border-black flex items-center justify-center">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="black"
                    strokeWidth="3"
                    strokeLinecap="square"
                    strokeLinejoin="miter"
                    className="w-5 h-5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="0" ry="0"></rect>
                    <path d="M9 3v18"></path>
                    <path d="M15 9h-6"></path>
                  </svg>
                </div>
                <div className="font-[family-name:var(--font-space-grotesk)] font-black text-xl sm:text-2xl tracking-tight">
                  1UI<span className="text-[#ff00ff]">.dev</span>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 bg-[#ffff00] border-4 border-black py-1 px-3 sm:px-4 text-sm font-black shadow-[4px_4px_0px_0px_#000]">
                <img
                  src="/images/jessin.png"
                  alt="User"
                  className="w-7 h-7 sm:w-8 sm:h-8 object-cover border-4 border-black"
                />
                <span className="hidden sm:inline">Jess's 2025</span>
                <span className="sm:hidden">Jess</span>
                <svg viewBox="0 0 24 24" fill="black" className="w-4 h-4">
                  <path d="M6 9l6 6 6-6"></path>
                </svg>
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-auto gap-4 sm:gap-6">
              {/* Hero Card */}
              <div className="md:col-span-2 bg-gradient-to-br from-[#ff00ff] via-[#ff00ff] to-[#ff6ec4] border-8 border-black p-6 sm:p-10 relative overflow-hidden flex flex-col justify-between min-h-[380px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]">
                <div className="absolute top-0 right-0 w-32 h-32 bg-[#00ff00] opacity-50 rotate-45 -translate-y-16 translate-x-16"></div>
                <div className="absolute bottom-0 left-0 w-40 h-40 border-8 border-[#ffff00] opacity-50 -translate-x-20 translate-y-20"></div>

                <div className="relative z-10 flex flex-col justify-end h-full">
                  <div className="inline-flex items-center gap-2 text-lg sm:text-xl font-black mb-6 bg-[#00ff00] border-4 border-black px-5 py-3 self-start shadow-[6px_6px_0px_0px_#000]">
                    <span className="text-2xl">★</span>
                    <span>Your Year Wrapped</span>
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-[80px] sm:text-[100px] lg:text-[140px] font-black leading-[0.85] tracking-tighter text-white [text-shadow:_8px_8px_0_#000] mb-6">
                    2025
                  </div>
                  <div className="bg-[#ffff00] border-4 border-black p-5 sm:p-6 shadow-[6px_6px_0px_0px_#000]">
                    <p className="text-base sm:text-lg font-black leading-relaxed">
                      You're in the top 1% of UI creators this year. You didn't just design; you shipped.
                    </p>
                  </div>
                </div>
              </div>

              {/* Stats Card */}
              <div className="bg-[#00ff00] text-black border-8 border-black p-6 sm:p-8 flex flex-col justify-between min-h-[380px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]">
                <div>
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 bg-[#ff00ff] px-2 py-1 inline-block border-2 border-black">
                    Total Components Used
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-5xl sm:text-6xl font-black leading-none mb-0 [text-shadow:_4px_4px_0_#ff00ff]">
                    1,492
                  </div>
                </div>

                <div className="mt-8">
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 bg-[#ffff00] px-2 py-1 inline-block border-2 border-black">
                    Lines of Code Copied
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl font-black leading-none mb-3 [text-shadow:_4px_4px_0_#ff00ff]">
                    84.5k
                  </div>
                  <div className="inline-flex items-center gap-1 bg-black text-[#00ff00] px-3 py-1 text-xs font-black border-4 border-[#00ff00] shadow-[4px_4px_0px_0px_#00ff00]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" className="w-3 h-3">
                      <path d="M18 15l-6-6-6 6"></path>
                    </svg>
                    +240% vs 2024
                  </div>
                </div>
              </div>

              {/* Design Persona Card */}
              <div className="bg-white text-black border-8 border-black p-6 sm:p-8 flex flex-col justify-between min-h-[320px] sm:min-h-[380px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]">
                <div className="flex justify-between items-start mb-6">
                  <span className="bg-[#ff00ff] text-white px-5 py-2.5 text-sm font-black border-4 border-black shadow-[4px_4px_0px_0px_#000]">
                    Design Persona
                  </span>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                    <circle cx="12" cy="12" r="3"></circle>
                    <circle cx="19" cy="12" r="3"></circle>
                    <circle cx="5" cy="12" r="3"></circle>
                  </svg>
                </div>

                <div className="text-center flex-1 flex flex-col justify-center">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 bg-[#00ff00] border-8 border-black flex items-center justify-center mx-auto mb-6 shadow-[8px_8px_0px_0px_#000]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#000"
                      strokeWidth="2"
                      strokeLinecap="square"
                      strokeLinejoin="miter"
                      className="w-10 h-10 sm:w-12 sm:h-12"
                    >
                      <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                      <polyline points="2 17 12 22 22 17"></polyline>
                      <polyline points="2 12 12 17 22 12"></polyline>
                    </svg>
                  </div>
                  <div className="text-sm font-black uppercase mb-2 bg-[#ffff00] inline-block px-3 py-1 mx-auto border-2 border-black">
                    You are a
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[36px] font-black leading-tight tracking-tight mb-6 [text-shadow:_3px_3px_0_#ff00ff]">
                    System
                    <br />
                    Architect
                  </div>
                </div>

                <div className="text-sm leading-relaxed font-black bg-[#00ffff] p-4 border-4 border-black">
                  Consistency is your currency. You love atomic design and reusable tokens.
                </div>
              </div>

              {/* Tech Stack Card */}
              <div className="md:col-span-2 bg-white border-8 border-black p-6 sm:p-8 min-h-[320px] sm:min-h-[380px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-xl sm:text-2xl font-black bg-[#ff00ff] text-white px-3 py-2 border-4 border-black">
                    Top Tech Stack
                  </h3>
                  <span className="text-xs sm:text-sm font-black bg-[#00ff00] px-2 py-1 border-2 border-black">
                    Based on exports
                  </span>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-4 p-3 bg-[#00ffff] border-4 border-black shadow-[6px_6px_0px_0px_#000]">
                    <div className="w-10 h-10 bg-[#61DAFB] border-4 border-black flex items-center justify-center flex-shrink-0">
                      <span className="text-black font-black text-sm">R</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">React</div>
                        <div className="text-xs font-black">68%</div>
                      </div>
                      <div className="h-3 w-full bg-black border-2 border-black overflow-hidden">
                        <div className="h-full bg-[#ff00ff]" style={{ width: "68%" }}></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-[#00ffff] border-4 border-black shadow-[6px_6px_0px_0px_#000]">
                    <div className="w-10 h-10 bg-[#06B6D4] border-4 border-black flex items-center justify-center flex-shrink-0">
                      <span className="text-white font-black text-sm">T</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">Tailwind CSS</div>
                        <div className="text-xs font-black">82%</div>
                      </div>
                      <div className="h-3 w-full bg-black border-2 border-black overflow-hidden">
                        <div className="h-full bg-[#00ff00]" style={{ width: "82%" }}></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-[#00ffff] border-4 border-black shadow-[6px_6px_0px_0px_#000]">
                    <div className="w-10 h-10 bg-[#3178C6] border-4 border-black flex items-center justify-center flex-shrink-0">
                      <span className="text-white font-black text-sm">TS</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">TypeScript</div>
                        <div className="text-xs font-black">54%</div>
                      </div>
                      <div className="h-3 w-full bg-black border-2 border-black overflow-hidden">
                        <div className="h-full bg-[#ffff00]" style={{ width: "54%" }}></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Top Category Card */}
              <div className="bg-[#ffff00] text-black border-8 border-black p-6 sm:p-8 relative overflow-hidden min-h-[320px] sm:min-h-[380px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]">
                <div className="absolute top-0 right-0 w-32 h-32 bg-[#ff00ff] opacity-30 rotate-45 translate-x-16 -translate-y-16"></div>
                <div className="absolute bottom-0 left-0 w-24 h-24 bg-[#00ff00] opacity-30 -translate-x-12 translate-y-12"></div>

                <div className="relative z-10 h-full flex flex-col justify-between">
                  <div>
                    <div className="font-black text-xs sm:text-sm uppercase mb-1 bg-black text-[#00ff00] inline-block px-3 py-1 border-2 border-[#00ff00]">
                      Top Category
                    </div>
                    <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[32px] font-black leading-none mt-4 [text-shadow:_4px_4px_0_#ff00ff]">
                      Dashboards
                    </div>
                  </div>

                  <div>
                    <div className="font-black text-sm mb-3 bg-[#ff00ff] text-white px-2 py-1 inline-block border-2 border-black">
                      Favorite Palette
                    </div>
                    <div className="flex gap-2">
                      <div className="w-12 h-12 bg-[#ff00ff] border-4 border-black shadow-[4px_4px_0px_0px_#000]"></div>
                      <div className="w-12 h-12 bg-[#00ff00] border-4 border-black shadow-[4px_4px_0px_0px_#000]"></div>
                      <div className="w-12 h-12 bg-[#ffff00] border-4 border-black shadow-[4px_4px_0px_0px_#000]"></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Peak Productivity Card */}
              <div className="bg-white border-8 border-black p-5 sm:p-6 min-h-[320px] sm:min-h-[380px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000] flex flex-col">
                <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 border-b-2 border-black pb-2">
                  Peak Productivity
                </div>
                <div className="text-2xl sm:text-[28px] font-black text-black mb-1">Tuesday, 10 PM</div>
                <div className="text-sm font-black mb-5">You are a night owl.</div>

                <div className="grid grid-cols-7 gap-1.5 mt-auto">
                  {[...Array(28)].map((_, i) => {
                    const isActive = [1, 3, 4, 7, 8, 9, 10, 11, 14, 15, 18, 22, 25, 26].includes(i)
                    return (
                      <div
                        key={i}
                        className={`aspect-square transition-all ${isActive ? "bg-[#ff00ff] border-4 border-black shadow-[2px_2px_0px_0px_#000]" : "bg-[#00ffff] border-2 border-black"}`}
                      ></div>
                    )
                  })}
                </div>
              </div>

              <div className="md:col-span-2 lg:col-span-4 bg-gradient-to-r from-[#ff00ff] via-[#00ff00] to-[#ffff00] border-8 border-black p-6 sm:p-8 lg:p-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 min-h-[200px] sm:min-h-[240px] shadow-[12px_12px_0px_0px_#000] transition-all hover:translate-x-1 hover:translate-y-1 hover:shadow-[8px_8px_0px_0px_#000]">
                <div>
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-2xl sm:text-3xl font-black mb-2 text-white">
                    Share your 2025 Wrapped
                  </h3>
                  <p className="text-white text-sm sm:text-base font-black">
                    Show the world what you've built with 1UI.dev
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
                  <button
                    onClick={handleDownloadImage}
                    className="bg-white text-black border-4 border-black px-6 py-3 sm:py-4 font-black text-sm sm:text-base transition-all hover:translate-x-1 hover:translate-y-1 shadow-[6px_6px_0px_0px_#000] hover:shadow-[4px_4px_0px_0px_#000] whitespace-nowrap"
                  >
                    Download Image
                  </button>
                  <button
                    onClick={handleShareOnX}
                    className="bg-black text-[#00ff00] px-6 py-3 sm:py-4 font-black text-sm sm:text-base transition-all hover:translate-x-1 hover:translate-y-1 flex items-center justify-center gap-2 border-4 border-[#00ff00] shadow-[6px_6px_0px_0px_#00ff00] hover:shadow-[4px_4px_0px_0px_#00ff00] whitespace-nowrap"
                  >
                    Share on
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-screen bg-gradient-to-br from-[#f093fb] via-[#7873f5] to-[#4facfe] text-white flex justify-center px-4 sm:px-6 lg:px-8 py-6 sm:py-10 lg:py-10">
          <style jsx global>{`
            @keyframes float {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(-20px); }
            }
            .float-animation {
              animation: float 6s ease-in-out infinite;
            }
          `}</style>

          <div ref={contentRef} className="w-full max-w-[1200px] flex flex-col gap-6">
            <header className="flex justify-between items-center py-4 sm:py-5 mb-4 sm:mb-5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-5 h-5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <path d="M9 3v18"></path>
                    <path d="M15 9h-6"></path>
                  </svg>
                </div>
                <div className="font-[family-name:var(--font-space-grotesk)] font-bold text-xl sm:text-2xl tracking-tight">
                  1UI<span className="text-[#ffeb3b]">.dev</span>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 bg-white/20 backdrop-blur-lg border border-white/30 py-1 px-3 sm:px-4 rounded-full text-sm font-medium shadow-lg">
                <img
                  src="/images/jessin.png"
                  alt="User"
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-full object-cover border-2 border-white/50"
                />
                <span className="hidden sm:inline">Jess's 2025</span>
                <span className="sm:hidden">Jess</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M6 9l6 6 6-6"></path>
                </svg>
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-auto gap-4 sm:gap-6">
              <div className="md:col-span-2 bg-gradient-to-br from-[#667eea] via-[#764ba2] to-[#f093fb] rounded-[32px] p-6 sm:p-10 relative overflow-hidden flex flex-col justify-between min-h-[380px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="absolute top-0 left-0 w-full h-full opacity-30">
                  <div className="absolute top-10 left-10 w-32 h-32 rounded-full bg-white/40 blur-3xl"></div>
                  <div className="absolute bottom-10 right-10 w-40 h-40 rounded-full bg-[#ffeb3b]/40 blur-3xl"></div>
                </div>
                <div className="relative z-10 flex flex-col justify-end h-full">
                  <div className="inline-flex items-center gap-2 text-lg sm:text-xl font-black mb-6 bg-white/20 backdrop-blur-md px-5 py-3 rounded-full border border-white/40 self-start shadow-lg">
                    <span className="text-2xl">✨</span>
                    <span>Your Year Wrapped</span>
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-8xl sm:text-[100px] lg:text-[140px] font-black leading-[0.85] tracking-tighter text-white [text-shadow:_5px_5px_0_rgb(0_0_0_/_20%)] mb-6">
                    2025
                  </div>
                  <div className="bg-white/20 backdrop-blur-xl border-2 border-white/30 p-5 sm:p-6 rounded-3xl shadow-xl">
                    <p className="text-base sm:text-lg font-black leading-relaxed">
                      You're in the top 1% of UI creators this year. You didn't just design; you shipped. 🚀
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#fa709a] to-[#fee140] text-black rounded-[32px] p-6 sm:p-8 flex flex-col justify-between min-h-[380px] border-2 border-white/50 shadow-2xl transition-all hover:scale-[1.02]">
                <div>
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 opacity-80">
                    Total Components Used
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-5xl sm:text-6xl font-black leading-none mb-0 [text-shadow:_3px_3px_0_rgb(255_255_255_/_50%)]">
                    1,492
                  </div>
                </div>

                <div className="mt-8">
                  <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 opacity-80">
                    Lines of Code Copied
                  </div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl font-black leading-none mb-3 [text-shadow:_3px_3px_0_rgb(255_255_255_/_50%)]">
                    84.5k
                  </div>
                  <div className="inline-flex items-center gap-1 bg-black/20 backdrop-blur-sm text-white px-3 py-1 rounded-full text-xs font-black border border-black/30">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-3 h-3">
                      <path d="M18 15l-6-6-6 6"></path>
                    </svg>
                    +240% vs 2024
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#a8edea] to-[#fed6e3] text-black rounded-[32px] p-6 sm:p-8 flex flex-col justify-between min-h-[320px] sm:min-h-[380px] border-2 border-white/50 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="flex justify-between items-start mb-6">
                  <span className="bg-gradient-to-r from-[#667eea] to-[#764ba2] text-white px-5 py-2.5 rounded-full text-sm font-black border-2 border-white/50 shadow-lg">
                    Design Persona 🎨
                  </span>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 opacity-50">
                    <circle cx="12" cy="12" r="2"></circle>
                    <circle cx="19" cy="12" r="2"></circle>
                    <circle cx="5" cy="12" r="2"></circle>
                  </svg>
                </div>

                <div className="text-center flex-1 flex flex-col justify-center">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 bg-gradient-to-br from-[#667eea] to-[#764ba2] rounded-full flex items-center justify-center mx-auto mb-6 shadow-2xl float-animation border-4 border-white/50">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-10 h-10 sm:w-12 sm:h-12"
                    >
                      <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                      <polyline points="2 17 12 22 22 17"></polyline>
                      <polyline points="2 12 12 17 22 12"></polyline>
                    </svg>
                  </div>
                  <div className="text-sm font-black uppercase mb-2 opacity-70 tracking-wide">You are a</div>
                  <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[36px] font-black leading-tight tracking-tight mb-6 [text-shadow:_2px_2px_0_rgb(255_255_255_/_50%)]">
                    System
                    <br />
                    Architect
                  </div>
                </div>

                <div className="text-sm leading-relaxed font-bold bg-white/30 backdrop-blur-sm p-4 rounded-2xl border border-white/50">
                  Consistency is your currency. You love atomic design and reusable tokens. 💎
                </div>
              </div>

              <div className="md:col-span-2 bg-white/10 backdrop-blur-xl rounded-[32px] p-6 sm:p-8 min-h-[320px] sm:min-h-[380px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-xl sm:text-2xl font-black">
                    Top Tech Stack 💻
                  </h3>
                  <span className="text-xs sm:text-sm font-bold opacity-70">Based on exports</span>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-4 p-3 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#61DAFB] to-[#00D8FF] flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-black text-sm">R</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">React</div>
                        <div className="text-xs font-black">68%</div>
                      </div>
                      <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#61DAFB] to-[#00D8FF]"
                          style={{ width: "68%" }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#06B6D4] to-[#38bdf8] flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-black text-sm">T</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">Tailwind CSS</div>
                        <div className="text-xs font-black">82%</div>
                      </div>
                      <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#06B6D4] to-[#38bdf8]"
                          style={{ width: "82%" }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3178C6] to-[#5199d8] flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-black text-sm">TS</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between mb-1">
                        <div className="font-black text-sm sm:text-base">TypeScript</div>
                        <div className="text-xs font-black">54%</div>
                      </div>
                      <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden backdrop-blur-sm">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#3178C6] to-[#5199d8]"
                          style={{ width: "54%" }}
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-[#f093fb] via-[#f5576c] to-[#ffd700] text-black rounded-[32px] p-6 sm:p-8 relative overflow-hidden min-h-[320px] sm:min-h-[380px] border-2 border-white/50 shadow-2xl transition-all hover:scale-[1.02]">
                <div className="absolute top-0 left-0 w-full h-full opacity-20">
                  <div className="absolute top-5 right-5 w-24 h-24 rounded-full bg-white blur-2xl"></div>
                  <div className="absolute bottom-5 left-5 w-32 h-32 rounded-full bg-[#ffeb3b] blur-2xl"></div>
                </div>
                <div className="relative z-10 h-full flex flex-col justify-between">
                  <div>
                    <div className="font-black text-xs sm:text-sm uppercase mb-1 bg-white/30 backdrop-blur-sm inline-block px-3 py-1 rounded-full">
                      Top Category 🏆
                    </div>
                    <div className="font-[family-name:var(--font-space-grotesk)] text-3xl sm:text-[32px] font-black leading-none mt-4 [text-shadow:_3px_3px_0_rgb(255_255_255_/_50%)]">
                      Dashboards
                    </div>
                  </div>

                  <div>
                    <div className="font-black text-sm mb-3">Favorite Palette 🎨</div>
                    <div className="flex gap-2">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#667eea] to-[#764ba2] border-2 border-white/50 shadow-lg"></div>
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#f093fb] to-[#f5576c] border-2 border-white/50 shadow-lg"></div>
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#ffd700] to-[#ffeb3b] border-2 border-white/50 shadow-lg"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white/10 backdrop-blur-xl rounded-[32px] p-5 sm:p-6 min-h-[320px] sm:min-h-[380px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02] flex flex-col">
                <div className="text-xs sm:text-sm uppercase tracking-wider font-black mb-2 opacity-70">
                  Peak Productivity 🌙
                </div>
                <div className="text-2xl sm:text-[28px] font-black text-white mb-1">Tuesday, 10 PM</div>
                <div className="text-sm font-bold mb-5 opacity-80">You are a night owl.</div>

                <div className="grid grid-cols-7 gap-1.5 mt-auto">
                  {[...Array(28)].map((_, i) => {
                    const isActive = [1, 3, 4, 7, 8, 9, 10, 11, 14, 15, 18, 22, 25, 26].includes(i)
                    return (
                      <div
                        key={i}
                        className={`aspect-square rounded-lg transition-all ${isActive ? "bg-gradient-to-br from-[#f093fb] to-[#f5576c] shadow-lg" : "bg-white/20"}`}
                      ></div>
                    )
                  })}
                </div>
              </div>

              <div className="md:col-span-2 lg:col-span-4 bg-white/10 backdrop-blur-xl rounded-[32px] p-6 sm:p-8 lg:p-12 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 min-h-[200px] sm:min-h-[240px] border-2 border-white/30 shadow-2xl transition-all hover:scale-[1.02]">
                <div>
                  <h3 className="font-[family-name:var(--font-space-grotesk)] text-2xl sm:text-3xl font-black mb-2">
                    Share your 2025 Wrapped ✨
                  </h3>
                  <p className="text-white/80 text-sm sm:text-base font-bold">
                    Show the world what you've built with 1UI.dev 🚀
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
                  <button
                    onClick={handleDownloadImage}
                    className="bg-white/20 backdrop-blur-md text-white border-2 border-white/30 px-6 py-3 sm:py-4 rounded-full font-black text-sm sm:text-base transition-all hover:scale-105 hover:bg-white/30 shadow-lg whitespace-nowrap"
                  >
                    Download Image
                  </button>
                  <button
                    onClick={handleShareOnX}
                    className="bg-white text-black px-6 py-3 sm:py-4 rounded-full font-black text-sm sm:text-base transition-all hover:scale-105 hover:bg-[#ffeb3b] flex items-center justify-center gap-2 shadow-xl whitespace-nowrap"
                  >
                    Share on
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
