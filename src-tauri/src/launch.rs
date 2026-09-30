//! 起動時にパネル・セットアップ画面を出すかの判定 (テスト可能な純粋関数)。

/// 開発用: `1` なら外部 ASR (MUKUCHI_ASR_URL) 使用中でも本番と同じくセットアップを開く (デバッグビルドのみ)
pub const ENV_DEV_SHOW_SETUP: &str = "MUKUCHI_DEV_SHOW_SETUP";

/// 判定に使う起動時の条件
#[derive(Debug, Clone, Copy, Default)]
pub struct LaunchInput {
    pub setup_completed: bool,
    /// デバッグビルドで MUKUCHI_ASR_URL (外部 ASR) を使っている
    pub dev_external_asr: bool,
    /// MUKUCHI_DEV_SHOW_SETUP=1
    pub dev_force_setup: bool,
    /// MUKUCHI_DEV_AUTO_LISTEN=1
    pub dev_auto_listen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchPlan {
    pub show_panel: bool,
    pub open_setup: bool,
}

impl LaunchInput {
    /// セットアップを済んだものとして扱うか。開発の外部 ASR ではモデル・実行環境を使わないため不要
    pub fn setup_unneeded(&self) -> bool {
        self.setup_completed || (self.dev_external_asr && !self.dev_force_setup)
    }
}

pub fn plan(i: LaunchInput) -> LaunchPlan {
    if i.setup_unneeded() {
        return LaunchPlan {
            show_panel: true,
            open_setup: false,
        };
    }
    if i.dev_auto_listen {
        // 自動テストではセットアップ画面を出さない (前面アプリを奪うため)。ONの様子はパネルで見る
        return LaunchPlan {
            show_panel: true,
            open_setup: false,
        };
    }
    // セットアップ完了前はパネルを出さない (セットアップの「試しに話す」ステップで show_panel する)
    LaunchPlan {
        show_panel: false,
        open_setup: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL_ONLY: LaunchPlan = LaunchPlan {
        show_panel: true,
        open_setup: false,
    };
    const SETUP_ONLY: LaunchPlan = LaunchPlan {
        show_panel: false,
        open_setup: true,
    };

    #[test]
    fn production() {
        let i = LaunchInput::default();
        assert_eq!(plan(i), SETUP_ONLY);
        assert_eq!(
            plan(LaunchInput {
                setup_completed: true,
                ..i
            }),
            PANEL_ONLY
        );
    }

    #[test]
    fn dev_external_asr_skips_setup() {
        let i = LaunchInput {
            dev_external_asr: true,
            ..Default::default()
        };
        assert_eq!(plan(i), PANEL_ONLY);
        assert!(i.setup_unneeded());
    }

    #[test]
    fn dev_force_setup_behaves_like_production() {
        let i = LaunchInput {
            dev_external_asr: true,
            dev_force_setup: true,
            ..Default::default()
        };
        assert_eq!(plan(i), SETUP_ONLY);
        assert!(!i.setup_unneeded());
        assert_eq!(
            plan(LaunchInput {
                setup_completed: true,
                ..i
            }),
            PANEL_ONLY
        );
    }

    #[test]
    fn dev_auto_listen_never_opens_setup() {
        for force in [false, true] {
            let i = LaunchInput {
                dev_auto_listen: true,
                dev_force_setup: force,
                ..Default::default()
            };
            assert_eq!(plan(i), PANEL_ONLY);
        }
    }
}
