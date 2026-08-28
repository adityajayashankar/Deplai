"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface PhoneInputProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  className?: string
  value?: string
  onChange?: (value: string) => void
}

function formatPhoneNumber(value: string): string {
  // Remove all non-digits
  const digits = value.replace(/\D/g, "")
  
  // Limit to 10 digits (US format)
  const limited = digits.slice(0, 10)
  
  // Format based on length
  if (limited.length === 0) return ""
  if (limited.length <= 3) return `(${limited}`
  if (limited.length <= 6) return `(${limited.slice(0, 3)}) ${limited.slice(3)}`
  return `(${limited.slice(0, 3)}) ${limited.slice(3, 6)}-${limited.slice(6)}`
}

export function PhoneInput({ className, value = "", onChange, ...props }: PhoneInputProps) {
  const [displayValue, setDisplayValue] = React.useState(() => formatPhoneNumber(value))
  
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const formatted = formatPhoneNumber(e.target.value)
    setDisplayValue(formatted)
    
    // Pass raw digits to parent
    const rawDigits = formatted.replace(/\D/g, "")
    onChange?.(rawDigits)
  }
  
  return (
    <Input
      type="tel"
      value={displayValue}
      onChange={handleChange}
      className={cn("h-12 bg-input border-border", className)}
      {...props}
    />
  )
}
