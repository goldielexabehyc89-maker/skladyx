"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()} className="w-full">
      <Printer size={18} /> Печать
    </Button>
  );
}
