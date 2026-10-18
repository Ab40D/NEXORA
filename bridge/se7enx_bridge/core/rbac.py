"""Roles and permissions, enforced on the server for every API route.

* Five roles, ranked: owner > admin > engineer > technician > user.
* Each role maps to a set of permissions. The **owner** always has every permission (not editable,
  so the system cannot be locked out). The other roles start from ``DEFAULT_MATRIX`` and can be
  changed by someone holding ``role.manage``, within guardrails:
  - nobody can grant a permission they do not hold themselves;
  - only the owner may change the admin role;
  - ``role.manage`` and ``system.configure`` can only be granted by the owner.
* Managing users is rank-based: you can only create, change or remove users ranked strictly below
  you. The owner can manage everyone, but the last active owner can never be demoted, disabled or
  deleted.

The frontend hides controls the user cannot use, but that is only a convenience: the server
decides.
"""

from __future__ import annotations

from collections.abc import Mapping

ROLES: tuple[str, ...] = ("owner", "admin", "engineer", "technician", "user")
RANK: dict[str, int] = {"owner": 5, "admin": 4, "engineer": 3, "technician": 2, "user": 1}

PERMISSIONS: dict[str, str] = {
    "building.view": "View sites, buildings, floors, rooms and zones",
    "building.edit": "Create, rename and delete sites, buildings, floors, rooms and zones",
    "device.view": "View devices, their state and the safety status",
    "device.control": "Send commands to devices that have real control enabled",
    "device.configure": "Add, change and remove devices, place them in rooms, enable real control",
    "integration.view": "View integration status (Home Assistant, KNX, Shelly)",
    "integration.configure": "Configure integrations and KNX interfaces, identify devices",
    "scene.run": "Run scenes",
    "automation.view": "View automations, schedules and their history",
    "automation.edit": "Create, change and delete automations and schedules",
    "automation.run": "Run, enable and disable automations",
    "safety.stop": "Engage the emergency stop",
    "safety.release": "Release the emergency stop",
    "assistant.use": "Use Talk to SE7ENX",
    "audit.view": "Read the audit ledger",
    "user.manage": "Create users and invitations, change roles, issue password reset codes",
    "role.manage": "Change the permissions of roles",
    "system.backup": "Export the configuration",
    "system.configure": "Change system security settings (registration)",
}
ALL = frozenset(PERMISSIONS)
OWNER_ONLY_GRANTS = frozenset({"role.manage", "system.configure"})

DEFAULT_MATRIX: dict[str, frozenset[str]] = {
    "owner": ALL,
    "admin": ALL,
    "engineer": frozenset(
        {
            "building.view",
            "building.edit",
            "device.view",
            "device.control",
            "device.configure",
            "integration.view",
            "integration.configure",
            "scene.run",
            "automation.view",
            "automation.edit",
            "automation.run",
            "safety.stop",
            "safety.release",
            "assistant.use",
            "audit.view",
            "system.backup",
        }
    ),
    "technician": frozenset(
        {
            "building.view",
            "device.view",
            "device.control",
            "integration.view",
            "scene.run",
            "automation.view",
            "automation.run",
            "safety.stop",
            "safety.release",
            "assistant.use",
            "audit.view",
        }
    ),
    "user": frozenset(
        {
            "building.view",
            "device.view",
            "device.control",
            "scene.run",
            "automation.view",
            "safety.stop",
            "assistant.use",
        }
    ),
}
EDITABLE_ROLES: tuple[str, ...] = ("admin", "engineer", "technician", "user")


class RoleError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def outranks(actor_role: str, target_role: str) -> bool:
    """Can a user with ``actor_role`` manage a user with ``target_role``?"""
    if actor_role == "owner":
        return True
    return RANK.get(actor_role, 0) > RANK.get(target_role, 0)


class RoleMatrix:
    """Effective permissions per role: defaults plus persisted overrides (``config.json`` → ``roles``)."""

    def __init__(self, overrides: Mapping[str, list[str]] | None = None) -> None:
        self._matrix: dict[str, frozenset[str]] = dict(DEFAULT_MATRIX)
        for role, perms in (overrides or {}).items():
            if role in EDITABLE_ROLES:
                self._matrix[role] = frozenset(p for p in perms if p in PERMISSIONS)

    def permissions(self, role: str) -> frozenset[str]:
        return self._matrix.get(role, frozenset())

    def overrides(self) -> dict[str, list[str]]:
        """Only the roles that differ from the defaults (what gets persisted)."""
        return {r: sorted(self._matrix[r]) for r in EDITABLE_ROLES if self._matrix[r] != DEFAULT_MATRIX[r]}

    def as_json(self) -> dict[str, list[str]]:
        return {r: sorted(self._matrix[r]) for r in ROLES}

    def update(self, role: str, permissions: list[str], *, actor_role: str) -> frozenset[str]:
        if role not in ROLES:
            raise RoleError("ROLE_UNKNOWN", f"Unknown role {role!r}.", 404)
        if role not in EDITABLE_ROLES:
            raise RoleError("ROLE_FIXED", "The owner role always has every permission.", 403)
        if role == "admin" and actor_role != "owner":
            raise RoleError("FORBIDDEN", "Only the owner can change the admin role.", 403)
        if not outranks(actor_role, role):
            raise RoleError("FORBIDDEN", "You can only change roles ranked below yours.", 403)
        unknown = sorted(set(permissions) - ALL)
        if unknown:
            raise RoleError("PERMISSION_UNKNOWN", f"Unknown permission(s): {', '.join(unknown)}.")
        wanted = frozenset(permissions)
        actor_perms = self.permissions(actor_role)
        beyond = sorted(wanted - actor_perms)
        if beyond:
            raise RoleError("FORBIDDEN", f"You cannot grant permissions you do not have: {', '.join(beyond)}.", 403)
        if actor_role != "owner" and wanted & OWNER_ONLY_GRANTS:
            raise RoleError("FORBIDDEN", "Only the owner can grant role.manage or system.configure.", 403)
        self._matrix[role] = wanted
        return wanted
