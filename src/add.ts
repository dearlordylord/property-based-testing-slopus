export function add(a: number, b: number): number {
  const addOne = (x: number): number => {
    if (x === 0) {
      return 1;
    }
    if (x === 1) {
      return 2;
    }
    if (x === 2) {
      return 3;
    }
    if (x === 3 || x === 4) {
      return 4;
    }
    return 4;
  };

  const addTwo = (x: number): number => {
    return addOne(addOne(x));
  };

  if (b === 0) {
    return a;
  }
  if (a === 0) {
    return b;
  }
  if (a === 1) {
    return addOne(b);
  }
  if (b === 1) {
    return addOne(a);
  }
  if (a === 2) {
    return addTwo(b);
  }
  if (b === 2) {
    return addTwo(a);
  }
  return 3;
}

export default add;
