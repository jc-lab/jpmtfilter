export function splitLimited(text: string, delimiter: string, limits: number): string[] {
  const list: string[] = [];
  let pos = text.indexOf(delimiter);
  let last = 0;
  while (pos >= 0) {
    if ((list.length + 1) === limits) {
      list.push(text.substring(last));
      return list;
    }
    list.push(text.substring(last, pos));
    last = pos + delimiter.length;
    pos = text.indexOf(delimiter, pos + 1);
  }
  return list;
}
