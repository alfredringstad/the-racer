import Phaser from 'phaser';

export interface DriveInput {
  throttle: boolean;
  brake: boolean;
  /** -1 = left, 1 = right */
  steer: number;
  handbrake: boolean;
}

/** Arrow keys or WASD, space for handbrake. */
export class Controls {
  private keys: Record<'up' | 'down' | 'left' | 'right' | 'w' | 'a' | 's' | 'd' | 'space', Phaser.Input.Keyboard.Key>;

  constructor(scene: Phaser.Scene) {
    const kb = scene.input.keyboard!;
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      up: kb.addKey(K.UP),
      down: kb.addKey(K.DOWN),
      left: kb.addKey(K.LEFT),
      right: kb.addKey(K.RIGHT),
      w: kb.addKey(K.W),
      a: kb.addKey(K.A),
      s: kb.addKey(K.S),
      d: kb.addKey(K.D),
      space: kb.addKey(K.SPACE),
    };
  }

  read(): DriveInput {
    const k = this.keys;
    const left = k.left.isDown || k.a.isDown;
    const right = k.right.isDown || k.d.isDown;
    return {
      throttle: k.up.isDown || k.w.isDown,
      brake: k.down.isDown || k.s.isDown,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: k.space.isDown,
    };
  }
}
