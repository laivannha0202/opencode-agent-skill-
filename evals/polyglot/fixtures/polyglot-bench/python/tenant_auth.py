def can_edit(user, resource):
    if not user or not resource:
        return False
    return user.get("role") == "admin"
