import { useMutation } from "@tanstack/react-query";
import { captureWriteSession, type WriteSession } from "@/sync/writeSession";

interface Callbacks<TData, TVariables> {
  onSuccess?: (data: TData, variables: TVariables) => unknown;
  onError?: (error: Error, variables: TVariables) => unknown;
}

/** 로컬 쓰기는 즉시 실행하고, 계정이 바뀐 작업의 부수 효과와 완료 콜백은 막는다. */
export function useSessionMutation<TData, TVariables = void>(
  options: Callbacks<TData, TVariables> & {
    mutationFn: (input: TVariables, session: WriteSession) => Promise<TData>;
    networkMode?: "always" | "online";
  },
) {
  const mutation = useMutation({
    networkMode: options.networkMode ?? "always",
    mutationFn: async ({ input, session }: { input: TVariables; session: WriteSession }) => {
      session.assertCurrent();
      const result = await options.mutationFn(input, session);
      session.assertCurrent();
      return result;
    },
    onSuccess: async (data, { input, session }) => {
      if (session.isCurrent()) await options.onSuccess?.(data, input);
    },
    onError: async (error, { input, session }) => {
      if (session.isCurrent()) await options.onError?.(error, input);
    },
  });
  const callbacksFor = (session: WriteSession, callbacks?: Callbacks<TData, TVariables>) => ({
    onSuccess: (data: TData, { input }: { input: TVariables }) => {
      if (session.isCurrent()) void callbacks?.onSuccess?.(data, input);
    },
    onError: (error: Error, { input }: { input: TVariables }) => {
      if (session.isCurrent()) void callbacks?.onError?.(error, input);
    },
  });
  return {
    ...mutation,
    variables: mutation.variables?.input,
    mutate(input: TVariables, callbacks?: Callbacks<TData, TVariables>) {
      const session = captureWriteSession();
      mutation.mutate({ input, session }, callbacksFor(session, callbacks));
    },
    mutateAsync(input: TVariables, callbacks?: Callbacks<TData, TVariables>) {
      const session = captureWriteSession();
      return mutation.mutateAsync({ input, session }, callbacksFor(session, callbacks));
    },
  };
}
