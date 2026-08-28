import React from "react"
import Link from "next/link"
import { Shield, Zap, Users } from "lucide-react"

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
      <div className="w-8 h-8 rounded-lg bg-foreground flex items-center justify-center">
        <span className="text-background font-bold text-sm">A</span>
      </div>
      <span className="font-semibold text-lg">Acme</span>
    </Link>
  )
}

const testimonial = {
  quote: "This platform transformed how we manage our workflow. The security and ease of use are unmatched.",
  author: "Sarah Chen",
  role: "Engineering Lead",
  company: "TechCorp",
}

const stats = [
  { value: "50K+", label: "Active users" },
  { value: "99.9%", label: "Uptime" },
  { value: "4.9/5", label: "User rating" },
]

const features = [
  { icon: Shield, label: "Enterprise security" },
  { icon: Zap, label: "Lightning fast" },
  { icon: Users, label: "Team collaboration" },
]

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex">
      {/* Rich left panel - hidden on mobile */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-card via-background to-card relative overflow-hidden">
        {/* Animated gradient orbs */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/4 -left-20 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl animate-gradient" />
          <div className="absolute bottom-1/4 -right-20 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-gradient" style={{ animationDelay: "-7s" }} />
        </div>
        
        {/* Content */}
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          {/* Logo */}
          <Logo />
          
          {/* Main content - Testimonial */}
          <div className="space-y-8">
            <blockquote className="space-y-4">
              <p className="text-2xl font-medium leading-relaxed text-foreground text-balance">
                "{testimonial.quote}"
              </p>
              <footer className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-medium">
                  {testimonial.author.split(" ").map(n => n[0]).join("")}
                </div>
                <div>
                  <p className="font-medium text-foreground">{testimonial.author}</p>
                  <p className="text-sm text-muted-foreground">{testimonial.role} at {testimonial.company}</p>
                </div>
              </footer>
            </blockquote>
            
            {/* Stats */}
            <div className="flex gap-8 pt-8 border-t border-border">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl font-bold text-foreground">{stat.value}</p>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
          
          {/* Features */}
          <div className="flex gap-6">
            {features.map((feature) => (
              <div key={feature.label} className="flex items-center gap-2 text-muted-foreground">
                <feature.icon className="w-4 h-4" />
                <span className="text-sm">{feature.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Main content area */}
      <main className="flex-1 flex flex-col">
        {/* Mobile header with logo */}
        <div className="lg:hidden p-6 pb-0">
          <Logo />
        </div>
        
        <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
          <div className="w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}
