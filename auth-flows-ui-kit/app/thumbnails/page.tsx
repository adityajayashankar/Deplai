import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Thumbnail } from "@/components/marketing/thumbnail"

export default function ThumbnailsPage() {
  return (
    <main className="min-h-screen py-12">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex items-center gap-4 mb-8">
          <Button asChild variant="ghost" size="sm" className="bg-transparent">
            <Link href="/">
              <ArrowLeft className="mr-1.5 h-3 w-3" />
              Back
            </Link>
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">Brand Assets</h1>
        </div>

        {/* Thumbnail */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Thumbnail</h2>
              <p className="text-sm text-muted-foreground mt-1">1200 x 630 -- marketplace / social card</p>
            </div>
            <Button asChild variant="outline" size="sm" className="bg-transparent">
              <Link href="/thumbnail">View full size</Link>
            </Button>
          </div>
          <div className="rounded-lg border border-border overflow-hidden bg-card">
            <div className="w-full overflow-x-auto">
              <div className="min-w-[600px]" style={{ aspectRatio: "1200/630" }}>
                <div className="w-full h-full" style={{ transform: "scale(1)", transformOrigin: "top left" }}>
                  <div className="relative" style={{ width: "100%", paddingBottom: "52.5%" }}>
                    <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
                      <div style={{ transform: "scale(0.5)", transformOrigin: "center center" }}>
                        <Thumbnail />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
