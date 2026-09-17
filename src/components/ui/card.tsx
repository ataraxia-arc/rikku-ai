import * as React from "react";
import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("rounded-2xl border border-white/10 bg-[#11171c]", className)} {...props} />; }
function CardHeader({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("grid gap-2 p-6", className)} {...props} />; }
function CardTitle({ className, ...props }: React.ComponentProps<"h2">) { return <h2 className={cn("text-xl font-medium tracking-tight", className)} {...props} />; }
function CardDescription({ className, ...props }: React.ComponentProps<"p">) { return <p className={cn("text-sm leading-6 text-[#8d9ba5]", className)} {...props} />; }
function CardContent({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("p-6 pt-0", className)} {...props} />; }

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
