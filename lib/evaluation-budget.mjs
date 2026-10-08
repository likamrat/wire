export const MINIMUM_SESSION_AI_CREDITS = 30;
export const SESSION_CREDIT_MINIMUM_MESSAGE = "Copilot requires at least 30 AI credits remaining for each assessment session. WIRE will not raise or top up your allowance. Review a new explicit allowance; charges are soft-capped and post-paid.";

export function sessionCreditLimit(requested, remaining) {
    const limit = Math.min(requested, remaining);
    if (!Number.isFinite(limit) || limit < MINIMUM_SESSION_AI_CREDITS) {
        throw Object.assign(new RangeError(SESSION_CREDIT_MINIMUM_MESSAGE), { code: "session-credit-minimum" });
    }
    return limit;
}
