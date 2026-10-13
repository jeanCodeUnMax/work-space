#!/usr/bin/env python3
"""
Audit Projects Tool - Hephaistos2-Kit
Read-only audit script scanning project directories across F: and E: drives.

Compares projects, detects duplicates, checks Git repositories and modification timestamps.
Strictly read-only: does not modify, move, or delete any files.
Zero emojis in code and output.
"""

import argparse
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def get_dir_mtime(path: Path) -> Tuple[datetime.datetime, str]:
    """Get the modification time of a directory."""
    try:
        stat = path.stat()
        mtime = datetime.datetime.fromtimestamp(stat.st_mtime)
        return mtime, mtime.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        fallback = datetime.datetime.fromtimestamp(0)
        return fallback, fallback.strftime("%Y-%m-%d %H:%M:%S")


def scan_directory(root_path: Path) -> Tuple[Dict[str, dict], List[str]]:
    """
    Scan a directory for projects (subdirectories) and standalone files/archives.
    Returns:
        (projects_dict, files_list)
        projects_dict: name -> {
            'name': str,
            'path': str,
            'has_git': bool,
            'mtime': datetime,
            'mtime_str': str
        }
    """
    projects = {}
    standalone_files = []

    if not root_path.exists():
        print(f"[AVERTISSEMENT] Repertoire introuvable ou inaccessible : {root_path}", file=sys.stderr)
        return projects, standalone_files

    try:
        entries = list(os.scandir(root_path))
    except Exception as e:
        print(f"[ERREUR] Impossible de scanner {root_path}: {e}", file=sys.stderr)
        return projects, standalone_files

    for entry in entries:
        try:
            if entry.is_dir(follow_symlinks=False):
                git_path = os.path.join(entry.path, ".git")
                # In standard repos .git is a directory; in worktrees or submodules .git is a file
                has_git = os.path.exists(git_path) and (os.path.isdir(git_path) or os.path.isfile(git_path))
                mtime, mtime_str = get_dir_mtime(Path(entry.path))
                projects[entry.name] = {
                    "name": entry.name,
                    "path": entry.path,
                    "has_git": has_git,
                    "mtime": mtime,
                    "mtime_str": mtime_str,
                }
            elif entry.is_file(follow_symlinks=False):
                standalone_files.append(entry.name)
        except Exception:
            # Skip permission or transient file errors
            continue

    return projects, standalone_files


def compare_projects(
    f_projects: Dict[str, dict],
    e_projects: Dict[str, dict]
) -> dict:
    """Compare project sets across F: and E: drives."""
    f_keys = set(f_projects.keys())
    e_keys = set(e_projects.keys())

    # Case-insensitive map for secondary detection
    f_lower = {k.lower(): k for k in f_keys}
    e_lower = {k.lower(): k for k in e_keys}

    exact_common = f_keys & e_keys
    only_f = f_keys - e_keys
    only_e = e_keys - f_keys

    # Check case differences
    case_mismatches = []
    for lk in sorted(set(f_lower.keys()) & set(e_lower.keys())):
        fk = f_lower[lk]
        ek = e_lower[lk]
        if fk != ek:
            f_info = f_projects[fk]
            e_info = e_projects[ek]
            time_diff = f_info["mtime"] - e_info["mtime"]
            diff_seconds = time_diff.total_seconds()
            if abs(diff_seconds) < 60:
                status = "IDENTICAL_TIMESTAMP"
            elif diff_seconds > 0:
                status = "F_NEWER"
            else:
                status = "E_NEWER"
            case_mismatches.append({
                "f_name": fk,
                "e_name": ek,
                "f_path": f_info["path"],
                "e_path": e_info["path"],
                "f_has_git": f_info["has_git"],
                "e_has_git": e_info["has_git"],
                "f_mtime": f_info["mtime_str"],
                "e_mtime": e_info["mtime_str"],
                "status": status,
                "diff_seconds": diff_seconds,
            })
            only_f.discard(fk)
            only_e.discard(ek)

    common_details = []
    for name in sorted(exact_common):
        f_info = f_projects[name]
        e_info = e_projects[name]

        time_diff = f_info["mtime"] - e_info["mtime"]
        diff_seconds = time_diff.total_seconds()

        if abs(diff_seconds) < 60:
            status = "IDENTICAL_TIMESTAMP"
        elif diff_seconds > 0:
            status = "F_NEWER"
        else:
            status = "E_NEWER"

        common_details.append({
            "name": name,
            "f_path": f_info["path"],
            "e_path": e_info["path"],
            "f_has_git": f_info["has_git"],
            "e_has_git": e_info["has_git"],
            "f_mtime": f_info["mtime_str"],
            "e_mtime": e_info["mtime_str"],
            "status": status,
            "diff_seconds": diff_seconds,
        })

    return {
        "common": common_details,
        "case_mismatches": case_mismatches,
        "only_f": sorted(list(only_f)),
        "only_e": sorted(list(only_e)),
    }


def generate_markdown_report(
    f_path: Path,
    e_path: Path,
    f_projects: Dict[str, dict],
    e_projects: Dict[str, dict],
    f_files: List[str],
    e_files: List[str],
    comparison: dict,
) -> str:
    """Generate clean Markdown audit summary."""
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    common = comparison["common"]
    only_f = comparison["only_f"]
    only_e = comparison["only_e"]
    case_mismatches = comparison["case_mismatches"]

    lines = [
        "# RAPPORT D'AUDIT COMPARATIF DES PROJETS (F: vs E:)",
        "",
        f"- Date de l'audit : {now_str}",
        f"- Source F : `{f_path}`{' (inaccessible)' if not f_path.exists() else ''}",
        f"- Source E : `{e_path}`{' (inaccessible)' if not e_path.exists() else ''}",
        "- Mode : Lecture seule stricte (zero modification)",
        "",
        "## 1. SYNTHESE GLOBALE",
        "",
        f"- Nombre de projets dans F : {len(f_projects)} (fichiers/archives : {len(f_files)})",
        f"- Nombre de projets dans E : {len(e_projects)} (fichiers/archives : {len(e_files)})",
        f"- Projets presents sur les DEUX disques (casse exacte) : {len(common)}",
        f"- Projets presents uniquement sur F : {len(only_f)}",
        f"- Projets presents uniquement sur E : {len(only_e)}",
    ]

    if case_mismatches:
        lines.append(f"- Projets avec difference de casse uniquement : {len(case_mismatches)}")

    lines.extend([
        "",
        "## 2. REPARTITION PAR STATUT (PROJETS PRESENTS SUR LES DEUX DISQUES)",
        "",
    ])

    f_newer = [c for c in common if c["status"] == "F_NEWER"]
    e_newer = [c for c in common if c["status"] == "E_NEWER"]
    same_time = [c for c in common if c["status"] == "IDENTICAL_TIMESTAMP"]

    lines.append(f"- Plus recents sur F: : {len(f_newer)}")
    lines.append(f"- Plus recents sur E: : {len(e_newer)}")
    lines.append(f"- Timestamps identiques (+/- 60s) : {len(same_time)}")
    lines.append("")

    lines.extend([
        "## 3. DETAIL DES PROJETS PRESENTS SUR LES DEUX DISQUES",
        "",
        "| Projet | Statut Recence | Date F: | Date E: | Git F: | Git E: |",
        "|---|---|---|---|---|---|",
    ])

    for item in common:
        git_f = "OUI" if item["f_has_git"] else "NON"
        git_e = "OUI" if item["e_has_git"] else "NON"
        lines.append(
            f"| `{item['name']}` | {item['status']} | {item['f_mtime']} | {item['e_mtime']} | {git_f} | {git_e} |"
        )

    if case_mismatches:
        lines.extend([
            "",
            "## 4. ANOMALIES DE CASSE (MEME NOM, CASSE DIFFERENTE)",
            "",
            "| Nom F: | Nom E: | Statut Recence | Date F: | Date E: | Git F: | Git E: |",
            "|---|---|---|---|---|---|---|",
        ])
        for cm in case_mismatches:
            git_f = "OUI" if cm["f_has_git"] else "NON"
            git_e = "OUI" if cm["e_has_git"] else "NON"
            lines.append(
                f"| `{cm['f_name']}` | `{cm['e_name']}` | {cm['status']} | {cm['f_mtime']} | {cm['e_mtime']} | {git_f} | {git_e} |"
            )

    lines.extend([
        "",
        "## 5. PROJETS UNIQUEMENT SUR F: (TOP 50)",
        "",
    ])
    for p in only_f[:50]:
        git_flag = " [git]" if f_projects[p]["has_git"] else ""
        lines.append(f"- `{p}` (modifie le {f_projects[p]['mtime_str']}){git_flag}")
    if len(only_f) > 50:
        lines.append(f"- ... et {len(only_f) - 50} autres projets sur F:")

    lines.extend([
        "",
        "## 6. PROJETS UNIQUEMENT SUR E: (TOP 50)",
        "",
    ])
    for p in only_e[:50]:
        git_flag = " [git]" if e_projects[p]["has_git"] else ""
        lines.append(f"- `{p}` (modifie le {e_projects[p]['mtime_str']}){git_flag}")
    if len(only_e) > 50:
        lines.append(f"- ... et {len(only_e) - 50} autres projets sur E:")

    lines.append("")
    return "\n".join(lines)


def generate_text_summary(
    f_path: Path,
    e_path: Path,
    f_projects: Dict[str, dict],
    e_projects: Dict[str, dict],
    f_files: List[str],
    e_files: List[str],
    comparison: dict,
    show_details: bool = False,
) -> str:
    """Generate plain text console summary."""
    common = comparison["common"]
    case_mismatches = comparison.get("case_mismatches", [])
    only_f = comparison["only_f"]
    only_e = comparison["only_e"]

    f_newer = [c for c in common if c["status"] == "F_NEWER"]
    e_newer = [c for c in common if c["status"] == "E_NEWER"]
    same_time = [c for c in common if c["status"] == "IDENTICAL_TIMESTAMP"]

    lines = [
        "=================================================================",
        "AUDIT COMPARATIF DES PROJETS (F: vs E:) - READ-ONLY",
        "=================================================================",
        f"F: {f_path} ({len(f_projects)} dossiers, {len(f_files)} fichiers){' [INACCESSIBLE]' if not f_path.exists() else ''}",
        f"E: {e_path} ({len(e_projects)} dossiers, {len(e_files)} fichiers){' [INACCESSIBLE]' if not e_path.exists() else ''}",
        "-----------------------------------------------------------------",
        f"Projets en commun (casse exacte) : {len(common)}",
        f"  - Plus recents sur F: : {len(f_newer)}",
        f"  - Plus recents sur E: : {len(e_newer)}",
        f"  - Timestamps identiques : {len(same_time)}",
    ]

    if case_mismatches:
        lines.append(f"Projets avec difference de casse : {len(case_mismatches)}")

    lines.extend([
        f"Projets uniques a F: : {len(only_f)}",
        f"Projets uniques a E: : {len(only_e)}",
        "=================================================================",
    ])

    if show_details and common:
        lines.append("DETAILS DES PROJETS EN COMMUN:")
        for c in common:
            git_status = f"Git: F={c['f_has_git']}, E={c['e_has_git']}"
            lines.append(f"  [{c['status']:<19}] {c['name']:<30} | {git_status}")

    if show_details and case_mismatches:
        lines.append("DETAILS DES DIFFERENCES DE CASSE:")
        for cm in case_mismatches:
            git_status = f"Git: F={cm['f_has_git']}, E={cm['e_has_git']}"
            lines.append(f"  [{cm['status']:<19}] F:{cm['f_name']:<20} vs E:{cm['e_name']:<20} | {git_status}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Audit read-only pour les dossiers projets de F: et E:"
    )
    parser.add_argument(
        "--f-dir",
        default=r"F:\Promgramation-teste",
        help="Chemin du repertoire F: (defaut: F:\\Promgramation-teste)",
    )
    parser.add_argument(
        "--e-dir",
        default=r"E:\Promgramation-teste",
        help="Chemin du repertoire E: (defaut: E:\\Promgramation-teste)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Chemin du fichier Markdown de rapport de sortie (optionnel)",
    )
    parser.add_argument(
        "--format",
        choices=["text", "markdown", "json"],
        default="text",
        help="Format d'affichage standard (text, markdown, json)",
    )
    parser.add_argument(
        "--details",
        action="store_true",
        help="Afficher la liste detaillee des projets en commun dans le terminal",
    )

    args = parser.parse_args()

    f_path = Path(args.f_dir)
    e_path = Path(args.e_dir)

    f_projects, f_files = scan_directory(f_path)
    e_projects, e_files = scan_directory(e_path)

    comparison = compare_projects(f_projects, e_projects)

    markdown_report = generate_markdown_report(
        f_path, e_path, f_projects, e_projects, f_files, e_files, comparison
    )

    if args.output:
        try:
            out_file = Path(args.output)
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(markdown_report, encoding="utf-8")
            print(f"[OK] Rapport Markdown genere dans : {out_file}", file=sys.stderr)
        except Exception as e:
            print(f"[ERREUR] Impossible d'ecrire le rapport : {e}", file=sys.stderr)

    if args.format == "markdown":
        print(markdown_report)
    elif args.format == "json":
        serializable_comparison = {
            "source_f": str(f_path),
            "source_e": str(e_path),
            "f_count": len(f_projects),
            "e_count": len(e_projects),
            "f_files_count": len(f_files),
            "e_files_count": len(e_files),
            "comparison": comparison,
        }
        print(json.dumps(serializable_comparison, indent=2))
    else:
        text_summary = generate_text_summary(
            f_path, e_path, f_projects, e_projects, f_files, e_files, comparison, args.details
        )
        print(text_summary)


if __name__ == "__main__":
    main()

