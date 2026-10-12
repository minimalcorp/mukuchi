// zip・cab の展開に使う tar の場所。Windows では OS 標準の bsdtar (System32\tar.exe) を名指しする。
// PATH 任せの "tar" は、Git for Windows の bash (release.yml の shell: bash) だと Git 同梱の GNU tar になり、
// "D:\..." を「ホスト D のファイル」と解釈して展開できない (tar: Cannot connect to D: resolve failed)
import path from "node:path";

export function tarCommand() {
  if (process.platform !== "win32") return "tar";
  return path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "tar.exe");
}
