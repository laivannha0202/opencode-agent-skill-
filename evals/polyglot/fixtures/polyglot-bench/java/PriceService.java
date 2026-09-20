public final class PriceService {
    public static long totalCents(long unitPriceCents, long quantity, long discountCents) {
        return unitPriceCents * quantity;
    }
}
