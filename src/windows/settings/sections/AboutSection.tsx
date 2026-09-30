import { useEffect, useState } from "react";
import { ChevronRight, FolderOpen, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { commands, type AppInfo } from "@/lib/ipc";
// アプリ本体のライセンス。オフラインで表示できるようバンドルに含める
import licenseText from "../../../../LICENSE?raw";
import { Card } from "./common";

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [license, setLicense] = useState(false);
  useEffect(() => {
    commands.getAppInfo().then(setInfo, () => {});
  }, []);

  return (
    <>
      <div className="flex items-center gap-3.5">
        <div className="flex size-12 items-center justify-center rounded-[10px] bg-gray-900 text-gray-0 dark:bg-gray-700">
          <Mic size={20} aria-hidden />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-lg leading-[1.4] font-semibold text-fg-strong">mukuchi</span>
          <span className="font-mono text-xs text-fg-muted">
            {info ? `バージョン ${info.version}（build ${info.build}）` : " "}
          </span>
        </div>
      </div>
      {/* 「アップデートを確認」は v0.1 では出さない (自動アップデートの導入時に追加) */}
      <Card className="text-sm">
        <div className="flex items-center border-b border-line-subtle px-3.5 py-2.5">
          <span className="flex-1">ライセンス</span>
          <Button size="sm" variant="ghost" iconRight={ChevronRight} onClick={() => setLicense(true)}>
            表示
          </Button>
        </div>
        <div className="flex items-center px-3.5 py-2.5">
          <span className="flex-1">ログ</span>
          <Button size="sm" variant="ghost" iconLeft={FolderOpen} onClick={() => void commands.openLogsFolder()}>
            Finder で開く
          </Button>
        </div>
      </Card>
      <Dialog open={license} onOpenChange={setLicense}>
        <DialogContent className="w-[560px]">
          <div className="flex flex-col gap-2 px-5 pt-5">
            <DialogTitle className="m-0 text-lg leading-[1.4] font-semibold text-fg-strong">ライセンス</DialogTitle>
            <DialogDescription className="m-0 text-sm text-fg-muted">Apache License 2.0</DialogDescription>
          </div>
          <pre className="mx-5 my-3.5 max-h-[300px] overflow-auto rounded-md border border-line-default p-3 font-mono text-2xs leading-[1.5] whitespace-pre-wrap text-fg-body select-text">
            {licenseText}
          </pre>
          <div className="flex justify-end px-5 pb-5">
            <Button onClick={() => setLicense(false)}>閉じる</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
