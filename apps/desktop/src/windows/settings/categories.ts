import type { SettingsCategory } from "@/lib/ipc";
import { CornerDownLeft, Cpu, HardDrive, Info, Mic, Settings as SettingsIcon, ShieldCheck, type LucideIcon } from "lucide-react";

// id は open_settings の category 引数・?category= と共通。名前は辞書の settings.categories
export const CATEGORIES = [
  { id: "general", icon: SettingsIcon },
  { id: "voice", icon: Mic },
  { id: "commands", icon: CornerDownLeft },
  { id: "recognition", icon: Cpu },
  { id: "permissions", icon: ShieldCheck },
  { id: "storage", icon: HardDrive },
  { id: "about", icon: Info },
] as const satisfies readonly { id: SettingsCategory; icon: LucideIcon }[];

export type CategoryId = SettingsCategory;

export function toCategory(value: unknown): CategoryId | null {
  return CATEGORIES.find((c) => c.id === value)?.id ?? null;
}
