//! Minimal line-based Unified Diff implementation matching difflib.unified_diff

pub fn unified_diff(old: &str, new: &str, path: &str) -> String {
    if old == new {
        return String::new();
    }

    let old_lines: Vec<&str> = old.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = new.split_inclusive('\n').collect();

    // LCS (Longest Common Subsequence) on line indices
    let m = old_lines.len();
    let n = new_lines.len();

    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 0..m {
        for j in 0..n {
            if old_lines[i] == new_lines[j] {
                dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
                dp[i + 1][j + 1] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    let mut diff_ops = Vec::new(); // (Op, line_str)
    let mut i = m;
    let mut j = n;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            diff_ops.push((' ', old_lines[i - 1]));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            diff_ops.push(('+', new_lines[j - 1]));
            j -= 1;
        } else if i > 0 {
            diff_ops.push(('-', old_lines[i - 1]));
            i -= 1;
        }
    }
    diff_ops.reverse();

    let mut out = String::new();
    out.push_str(&format!("--- a/{}\n", path));
    out.push_str(&format!("+++ b/{}\n", path));
    out.push_str(&format!("@@ -1,{} +1,{} @@\n", m, n));

    for (op, line) in diff_ops {
        out.push(op);
        out.push_str(line);
        if !line.ends_with('\n') {
            out.push('\n');
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_identical() {
        assert_eq!(unified_diff("hello\n", "hello\n", "test.txt"), "");
    }

    #[test]
    fn test_diff_replacement() {
        let old = "foo\nbar\n";
        let new = "foo\nbaz\n";
        let d = unified_diff(old, new, "file.txt");
        assert!(d.contains("--- a/file.txt"));
        assert!(d.contains("+++ b/file.txt"));
        assert!(d.contains("-bar"));
        assert!(d.contains("+baz"));
    }
}
