import { CornerDownLeft, Cpu, HardDrive, Info, Mic, Settings as SettingsIcon, ShieldCheck, type LucideIcon } from "lucide-react";

// id は open_settings の category 引数・?category= と共通
export const CATEGORIES = [
  { id: "general", label: "一般", icon: SettingsIcon },
  { id: "voice", label: "音声入力", icon: Mic },
  { id: "commands", label: "音声コマンド", icon: CornerDownLeft },
  { id: "recognition", label: "認識", icon: Cpu },
  { id: "permissions", label: "権限", icon: ShieldCheck },
  { id: "storage", label: "ストレージ", icon: HardDrive },
  { id: "about", label: "このアプリについて", icon: Info },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type CategoryId = (typeof CATEGORIES)[number]["id"];
