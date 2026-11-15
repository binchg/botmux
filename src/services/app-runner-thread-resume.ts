/** Never replace a stored conversation when its history cannot be loaded. */
export async function resumeStoredAppThread(
  request: (method: string, params: Record<string, unknown>) => Promise<any>,
  threadId: string,
  params: Record<string, unknown>,
): Promise<any> {
  try {
    const result = await request('thread/resume', { ...params, threadId });
    if (result?.thread?.id !== threadId) {
      throw new Error(`thread/resume returned a different conversation (${result?.thread?.id ?? 'missing id'})`);
    }
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resume stored conversation ${threadId}; original binding preserved. ${detail}`);
  }
}
