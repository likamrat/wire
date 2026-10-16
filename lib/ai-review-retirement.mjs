import { BoardError } from "./store.mjs";

export function rejectAIReview() {
    const error = new BoardError("AI review and automatic scoring are no longer supported. No evaluation was started or changed.", 410);
    error.code = "AI_REVIEW_RETIRED";
    throw error;
}

export function rejectPersonalFeedback() {
    const error = new BoardError("Personal feedback is no longer supported. No feedback was saved or changed.", 410);
    error.code = "PERSONAL_FEEDBACK_RETIRED";
    throw error;
}
