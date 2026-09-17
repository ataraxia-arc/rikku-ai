import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} className={cn("flex h-11 w-full rounded-[10px] border border-white/10 bg-[#0d1216] px-3 text-base text-[#f5f7f8] outline-none placeholder:text-[#53616a] focus:border-[#00f0ff]/45 focus:ring-2 focus:ring-[#00f0ff]/10 disabled:opacity-50 md:text-sm", className)} {...props} />;
}

export { Input };
