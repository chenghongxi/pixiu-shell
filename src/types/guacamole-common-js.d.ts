declare module "guacamole-common-js" {
  class WebSocketTunnel {
    constructor(url: string);
  }

  class Keyboard {
    constructor(element: Element);
    onkeydown: ((keysym: number) => boolean) | null;
    onkeyup: ((keysym: number) => boolean) | null;
  }

  class Mouse {
    constructor(element: Element);
    onmousedown: ((state: MouseState) => void) | null;
    onmouseup: ((state: MouseState) => void) | null;
    onmousemove: ((state: MouseState) => void) | null;
  }

  interface MouseState {
    x: number;
    y: number;
    buttonMask: number;
  }

  class Client {
    constructor(tunnel: WebSocketTunnel);
    onstatechange: ((state: number) => void) | null;
    onerror: ((error: { message?: string }) => void) | null;
    getDisplay(): {
      getElement(): HTMLElement;
      getWidth(): number;
      getHeight(): number;
      getScale(): number;
      scale(value: number): void;
      onresize: ((width: number, height: number) => void) | null;
    };
    connect(data?: string): void;
    disconnect(): void;
    sendSize(width: number, height: number, dpi?: number): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    sendMouseState(state: MouseState, applyDisplayScale?: boolean): void;
  }

  class Tunnel {
    oninstruction: ((opcode: string, args: string[]) => void) | null;
    state: number;
    connect(data?: string): void;
    disconnect(): void;
    sendMessage(...elements: unknown[]): void;
    setState(state: number): void;
  }

  class Parser {
    oninstruction: ((opcode: string, args: string[]) => void) | null;
    receive(data: string): void;
  }

  export { Client, Keyboard, Mouse, Parser, Tunnel, WebSocketTunnel };

  const Guacamole: {
    Client: typeof Client;
    Keyboard: typeof Keyboard;
    Mouse: typeof Mouse;
    WebSocketTunnel: typeof WebSocketTunnel;
    Parser: typeof Parser;
    Tunnel: typeof Tunnel;
  };
  export default Guacamole;
}
