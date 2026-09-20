public static class OrderService
{
    public static bool CanUpdate(User user, Order order)
    {
        if (user == null || order == null) return false;
        return user.Role == "Admin";
    }
}
