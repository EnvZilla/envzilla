# 🔐 Security Policy

Thank you for helping us tame the EnvZilla beast! We take security seriously and appreciate your efforts to disclose vulnerabilities responsibly.

---

## 📬 Reporting a Vulnerability

If you believe you’ve found a **security vulnerability**, please help us by **not** creating a public GitHub issue. Public disclosures can put the entire community at risk.

Instead, please report the issue to us privately:

- 📧 **Email**: `security@envzilla.dev`
- 🛡️ **GitHub**: Use [Private Vulnerability Reporting](https://github.com/EnvZilla/EnvZilla/security/advisories)

We will do our best to respond within **48 hours**.

---

## 🎯 Scope

We are most interested in vulnerabilities that could lead to:

- 🐛 Remote Code Execution (RCE) via untrusted pull requests.
- 🔓 Container escapes or improper permission isolation.
- 🕵️‍♀️ Exposure of secrets, tokens, or environment variables.

Issues related to your own application's code inside a preview environment or intentional resource exhaustion (DoS) are generally out of scope.

---

## ✅ Our Defenses

To keep the beast in its cage, we implement several security best practices:

- ✅ All GitHub webhooks are verified with a secret key.
- ✅ Untrusted code runs in isolated containers with strict resource limits.
- ✅ No data or volumes are persisted or shared between builds.
- ✅ We use static analysis and build-timeouts to mitigate abuse.

---

## 🙏 Ethical Research

We welcome security research and will happily credit valid disclosures. When testing, please use non-destructive methods and never act against infrastructure you do not own.

Thank you for helping keep EnvZilla and its users safe!

---

#### See also:

- [README](./README.md)
- [Contributing Guide](./CONTRIBUTING.md)