import * as React from "react";
import { cn } from "@/lib/utils";

function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("inline-flex items-center rounded-md border border-[#00f0ff]/20 bg-[#00f0ff]/5 px-2 py-1 font-mono text-[10px] font-semibold tracking-[.12em] text-[#67bcc2]", className)} {...props} />;
}

export { Badge };
