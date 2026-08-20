"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "destructive";

export function Button({
  variant = "primary",
  small = false,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${small ? "btn-sm" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
