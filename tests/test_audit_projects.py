"""
Unit tests for tools/audit-projects.py
Verifies scanning, comparison, report formatting, and strict read-only behavior.
"""

import datetime
import importlib.util
import json
from pathlib import Path
import pytest

# Dynamically import audit-projects.py
tool_path = Path(__file__).resolve().parent.parent / "tools" / "audit-projects.py"
spec = importlib.util.spec_from_file_location("audit_projects", str(tool_path))
audit_projects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_projects)


def test_scan_directory(tmp_path):
    f_root = tmp_path / "F_projects"
    f_root.mkdir()

    # Create standard repo with .git directory
    proj1 = f_root / "proj_alpha"
    proj1.mkdir()
    (proj1 / ".git").mkdir()

    # Create repo with .git as file (git worktree / submodule)
    proj2 = f_root / "proj_worktree"
    proj2.mkdir()
    (proj2 / ".git").write_text("gitdir: /path/to/main/.git/worktrees/proj_worktree")

    # Create project without git
    proj3 = f_root / "proj_no_git"
    proj3.mkdir()

    # Create standalone file
    (f_root / "archive.zip").write_text("dummy")

    projects, files = audit_projects.scan_directory(f_root)

    assert "proj_alpha" in projects
    assert projects["proj_alpha"]["has_git"] is True
    assert "proj_worktree" in projects
    assert projects["proj_worktree"]["has_git"] is True
    assert "proj_no_git" in projects
    assert projects["proj_no_git"]["has_git"] is False
    assert "archive.zip" in files


def test_scan_missing_directory(tmp_path):
    missing_dir = tmp_path / "non_existent_folder"
    projects, files = audit_projects.scan_directory(missing_dir)
    assert projects == {}
    assert files == []


def test_compare_projects_and_case_mismatches():
    now = datetime.datetime.now()
    earlier = now - datetime.timedelta(days=2)

    f_projects = {
        "shared_f_newer": {
            "name": "shared_f_newer",
            "path": "F:/shared_f_newer",
            "has_git": True,
            "mtime": now,
            "mtime_str": now.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "CaseSensitiveProj": {
            "name": "CaseSensitiveProj",
            "path": "F:/CaseSensitiveProj",
            "has_git": True,
            "mtime": now,
            "mtime_str": now.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "only_on_f": {
            "name": "only_on_f",
            "path": "F:/only_on_f",
            "has_git": False,
            "mtime": now,
            "mtime_str": now.strftime("%Y-%m-%d %H:%M:%S"),
        },
    }

    e_projects = {
        "shared_f_newer": {
            "name": "shared_f_newer",
            "path": "E:/shared_f_newer",
            "has_git": False,
            "mtime": earlier,
            "mtime_str": earlier.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "casesensitiveproj": {
            "name": "casesensitiveproj",
            "path": "E:/casesensitiveproj",
            "has_git": False,
            "mtime": earlier,
            "mtime_str": earlier.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "only_on_e": {
            "name": "only_on_e",
            "path": "E:/only_on_e",
            "has_git": True,
            "mtime": now,
            "mtime_str": now.strftime("%Y-%m-%d %H:%M:%S"),
        },
    }

    comp = audit_projects.compare_projects(f_projects, e_projects)

    assert len(comp["common"]) == 1
    common_item = comp["common"][0]
    assert common_item["name"] == "shared_f_newer"
    assert common_item["status"] == "F_NEWER"
    assert common_item["f_has_git"] is True
    assert common_item["e_has_git"] is False

    assert len(comp["case_mismatches"]) == 1
    cm = comp["case_mismatches"][0]
    assert cm["f_name"] == "CaseSensitiveProj"
    assert cm["e_name"] == "casesensitiveproj"
    assert cm["status"] == "F_NEWER"
    assert cm["f_has_git"] is True
    assert cm["e_has_git"] is False

    assert "only_on_f" in comp["only_f"]
    assert "only_on_e" in comp["only_e"]


def test_markdown_and_text_report():
    f_path = Path("F:/test")
    e_path = Path("E:/test")
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    f_projects = {
        "p1": {"name": "p1", "path": "F:/p1", "has_git": True, "mtime": datetime.datetime.now(), "mtime_str": now_str}
    }
    e_projects = {
        "p1": {"name": "p1", "path": "E:/p1", "has_git": False, "mtime": datetime.datetime.now(), "mtime_str": now_str}
    }
    f_files = []
    e_files = []
    comp = {
        "common": [{
            "name": "p1", "status": "IDENTICAL_TIMESTAMP", "f_mtime": now_str, "e_mtime": now_str,
            "f_has_git": True, "e_has_git": False
        }],
        "case_mismatches": [{
            "f_name": "P2", "e_name": "p2", "status": "F_NEWER", "f_mtime": now_str, "e_mtime": now_str,
            "f_has_git": True, "e_has_git": False
        }],
        "only_f": [],
        "only_e": [],
    }

    md = audit_projects.generate_markdown_report(
        f_path, e_path, f_projects, e_projects, f_files, e_files, comp
    )
    assert "# RAPPORT D'AUDIT COMPARATIF DES PROJETS (F: vs E:)" in md
    assert "## 4. ANOMALIES DE CASSE" in md
    assert "`P2`" in md
    assert "`p2`" in md

    txt = audit_projects.generate_text_summary(
        f_path, e_path, f_projects, e_projects, f_files, e_files, comp, show_details=True
    )
    assert "AUDIT COMPARATIF DES PROJETS (F: vs E:) - READ-ONLY" in txt
    assert "Projets avec difference de casse : 1" in txt
    assert "DETAILS DES DIFFERENCES DE CASSE:" in txt


def test_strict_read_only(tmp_path):
    root = tmp_path / "readonly_test"
    root.mkdir()
    p = root / "sample_project"
    p.mkdir()
    (p / "file.txt").write_text("immutable content")

    mtime_before = p.stat().st_mtime
    projects, files = audit_projects.scan_directory(root)

    mtime_after = p.stat().st_mtime
    assert mtime_before == mtime_after
    assert (p / "file.txt").read_text() == "immutable content"

