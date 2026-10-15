/** 恢复运行中的 App 会话时，回复归属仍使用飞书用户轮次，不能改用模型内部轮次。 */
export function codexAppReplyOwner(userTurnId?: string, runnerTurnId?: string): string | undefined {
  return userTurnId ?? runnerTurnId;
}
