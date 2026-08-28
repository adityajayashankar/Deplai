"use client"

import * as React from "react"

interface Particle {
  id: number
  x: number
  y: number
  rotation: number
  color: string
  scale: number
  velocityX: number
  velocityY: number
}

export function Confetti() {
  const [particles, setParticles] = React.useState<Particle[]>([])
  
  React.useEffect(() => {
    const colors = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#8b5cf6"]
    const newParticles: Particle[] = []
    
    for (let i = 0; i < 50; i++) {
      newParticles.push({
        id: i,
        x: Math.random() * 100,
        y: -10 - Math.random() * 20,
        rotation: Math.random() * 360,
        color: colors[Math.floor(Math.random() * colors.length)],
        scale: 0.5 + Math.random() * 0.5,
        velocityX: (Math.random() - 0.5) * 2,
        velocityY: 3 + Math.random() * 3,
      })
    }
    
    setParticles(newParticles)
    
    // Clean up after animation
    const timer = setTimeout(() => {
      setParticles([])
    }, 4000)
    
    return () => clearTimeout(timer)
  }, [])
  
  if (particles.length === 0) return null
  
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-50">
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="absolute w-3 h-3 animate-confetti"
          style={{
            left: `${particle.x}%`,
            top: `${particle.y}%`,
            backgroundColor: particle.color,
            transform: `rotate(${particle.rotation}deg) scale(${particle.scale})`,
            animationDelay: `${particle.id * 20}ms`,
            borderRadius: particle.id % 2 === 0 ? "50%" : "0",
          }}
        />
      ))}
    </div>
  )
}
