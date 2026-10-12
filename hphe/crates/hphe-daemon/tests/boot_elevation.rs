//! Tests for boot sequence without elevation.

use hphe_daemon::{check_elevation, is_elevated, DaemonConfig, DaemonError, HpheDaemon};

#[test]
fn test_elevation_check_behavior() {
    let elevated = is_elevated();
    let result = check_elevation("C:");

    if elevated {
        assert!(result.is_ok());
    } else {
        assert!(result.is_err());
        let err = result.unwrap_err();
        let message = err.to_string();
        assert!(message.contains("[ELEVATION REQUISE]"));
        assert!(message.contains("Administrator privileges required"));
        assert!(message.contains("powershell"));
        assert!(message.contains("install.ps1"));
    }
}

#[test]
fn test_boot_without_elevation_fails_cleanly() {
    // When elevation is not present, attempting to boot a live volume without
    // the bypass flag must fail cleanly with ElevationRequired.
    if !is_elevated() {
        let config = DaemonConfig {
            drive: "C".to_string(),
            no_elevation_check: false,
            synthetic: false,
            ..Default::default()
        };

        let result = HpheDaemon::boot(config);
        assert!(result.is_err());
        match result.unwrap_err() {
            DaemonError::ElevationRequired(err) => {
                assert_eq!(err.drive, "C");
                let msg = err.to_string();
                assert!(msg.contains("Administrator privileges"));
            }
            other => panic!("Expected ElevationRequired error, got: {other:?}"),
        }
    }
}

#[test]
fn test_boot_synthetic_mode_succeeds_without_elevation() {
    // Synthetic mode allows testing, CI, and benchmarks without requiring administrator elevation.
    let count = 500;
    let config = DaemonConfig {
        drive: "C".to_string(),
        synthetic: true,
        synthetic_count: count,
        no_elevation_check: false,
        ..Default::default()
    };

    let daemon = HpheDaemon::boot(config).expect("Synthetic boot must succeed without elevation");
    assert_eq!(daemon.index().len(), count);
    assert_eq!(daemon.config().drive_char(), 'C');
}
