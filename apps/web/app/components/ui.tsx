import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import {
  AppWindowIcon,
  ArrowRightIcon,
  BanIcon,
  BookAIcon,
  CheckIcon,
  CircleCheckIcon,
  ClockIcon,
  CodeXmlIcon,
  CpuIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfinityIcon,
  InfoIcon,
  KeyboardIcon,
  LanguagesIcon,
  LaptopIcon,
  LinkIcon,
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  PanelTopIcon,
  RepeatIcon,
  ShareIcon,
  Trash2Icon,
  UserRoundIcon,
  WifiOffIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

// デザインの Icon (lucide-static の名前指定) を lucide-react に対応させる
const ICONS = {
  "app-window": AppWindowIcon,
  "arrow-right": ArrowRightIcon,
  ban: BanIcon,
  "book-a": BookAIcon,
  check: CheckIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  "code-xml": CodeXmlIcon,
  cpu: CpuIcon,
  download: DownloadIcon,
  "external-link": ExternalLinkIcon,
  infinity: InfinityIcon,
  info: InfoIcon,
  keyboard: KeyboardIcon,
  languages: LanguagesIcon,
  laptop: LaptopIcon,
  link: LinkIcon,
  mic: MicIcon,
  "mic-off": MicOffIcon,
  monitor: MonitorIcon,
  "panel-top": PanelTopIcon,
  repeat: RepeatIcon,
  share: ShareIcon,
  "trash-2": Trash2Icon,
  "user-round": UserRoundIcon,
  "wifi-off": WifiOffIcon,
  x: XIcon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const C = ICONS[name];
  return <C size={size} aria-hidden="true" className={`flex-none ${className ?? ""}`} />;
}

// ボタン (primary / secondary / ghost、sm / lg)。押下は 0.5px 沈み込み、無効は opacity .5
type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-sans font-medium leading-[1.4] no-underline transition-[background-color,border-color,color] duration-[120ms] ease-standard active:translate-y-[0.5px] disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50";
const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs",
  lg: "h-10 px-[18px] text-sm",
};
const VARIANTS: Record<Variant, string> = {
  primary: "border-primary bg-primary text-white",
  secondary: "border-line-strong bg-white text-body shadow-xs",
  ghost: "border-transparent bg-transparent text-body",
};
// 無効なボタンはホバーで色を変えない
const HOVER: Record<Variant, string> = {
  primary: "hover:border-primary-hover hover:bg-primary-hover",
  secondary: "hover:bg-hover",
  ghost: "hover:bg-hover",
};

function buttonClass(variant: Variant, size: Size, enabled: boolean, className?: string) {
  return [
    BASE,
    SIZES[size],
    VARIANTS[variant],
    enabled ? HOVER[variant] : "",
    className ?? "",
  ].join(" ");
}

interface CommonProps {
  variant?: Variant;
  size?: Size;
  iconLeft?: IconName;
  iconRight?: IconName;
  children: ReactNode;
}

function Inner({ size, iconLeft, iconRight, children }: CommonProps & { size: Size }) {
  const iconSize = size === "lg" ? 16 : 14;
  return (
    <>
      {iconLeft && <Icon name={iconLeft} size={iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </>
  );
}

export function Button({
  variant = "secondary",
  size = "lg",
  iconLeft,
  iconRight,
  children,
  className,
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={buttonClass(variant, size, !rest.disabled, className)}
      {...rest}
    >
      <Inner size={size} iconLeft={iconLeft} iconRight={iconRight}>
        {children}
      </Inner>
    </button>
  );
}

/** 遷移・ダウンロードはリンクとして置く (JS なしでも動き、右クリックで URL をコピーできる) */
export function ButtonLink({
  variant = "secondary",
  size = "lg",
  iconLeft,
  iconRight,
  children,
  className,
  ...rest
}: CommonProps & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass(variant, size, true, className)} {...rest}>
      <Inner size={size} iconLeft={iconLeft} iconRight={iconRight}>
        {children}
      </Inner>
    </a>
  );
}

// バッジ (success / neutral)
export function Badge({ tone, children }: { tone: "success" | "neutral"; children: ReactNode }) {
  const color = tone === "success" ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full px-2 font-sans text-xs leading-[1.4] font-medium whitespace-nowrap ${color}`}
    >
      {children}
    </span>
  );
}

/**
 * キーキャップ。文中 (md: 13px) と表の中 (sm: 12px) で使う。
 * 修飾キーとキーは 1 つの枠に空白区切りで並べる (デザインの「⌥ Space」)
 */
export function Keycap({ keys, size = "md" }: { keys: readonly string[]; size?: "sm" | "md" }) {
  return (
    <kbd
      className={`inline-block flex-none rounded-sm border border-b-2 border-line-strong bg-white px-1.5 font-mono font-medium whitespace-nowrap text-strong ${size === "md" ? "text-[13px] leading-[22px]" : "text-xs leading-5"}`}
    >
      {keys.join(" ")}
    </kbd>
  );
}
