export enum eStratumErrorCode {
  'OtherUnknown' = 20,
  'JobNotFound' = 21, // (=stale)
  'DuplicateShare' = 22,
  'LowDifficultyShare' = 23,
  'UnauthorizedWorker' = 24,
  'NotSubscribed' = 25,
}
