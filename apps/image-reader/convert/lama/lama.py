# LaMa's FFC ResNet generator, shortened to the options big-lama uses, from
# https://github.com/advimman/lama (saicinpainting/training/modules/ffc.py).
# Copyright 2021 Samsung Research. Licensed under the Apache License, Version 2.0.
#
# FourierUnit computes its 2D FFTs as matrix multiplications with cos/sin matrices built from the input's size.
# torch.onnx exports rfftn/irfftn as ONNX DFT ops, which ONNX Runtime runs about 40 times slower than torch for
# sizes that aren't powers of two; matrix multiplications run fast on every backend at any size.
import math

import torch
from torch import nn


def angles(n, k):
    i = torch.arange(n, dtype=torch.int64)
    j = torch.arange(k, dtype=torch.int64)
    product = i[:, None] * j[None, :]
    # Reducing n * k modulo n keeps float32 cos/sin exact for large sizes.
    product = product - torch.div(product, n, rounding_mode="floor") * n
    return product.to(torch.float32) * (2 * math.pi / n)


class FourierUnit(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv_layer = nn.Conv2d(channels * 2, channels * 2, kernel_size=1, bias=False)
        self.bn = nn.BatchNorm2d(channels * 2)
        self.relu = nn.ReLU(inplace=True)

    def forward(self, x):
        batch, _, height, width = x.shape
        half = width // 2 + 1
        scale = torch.rsqrt(torch.tensor(height * width, dtype=torch.float32))
        width_angles, height_angles = angles(width, half), angles(height, height)
        cos_w, sin_w = torch.cos(width_angles), torch.sin(width_angles)
        cos_h, sin_h = torch.cos(height_angles), torch.sin(height_angles)
        # rfftn with norm="ortho": real FFT along the width, then complex FFT along the height.
        real, imag = x @ cos_w, -(x @ sin_w)
        real, imag = (cos_h @ real + sin_h @ imag) * scale, (cos_h @ imag - sin_h @ real) * scale
        ffted = torch.stack((real, imag), dim=2).reshape(batch, -1, height, half)

        ffted = self.relu(self.bn(self.conv_layer(ffted)))

        ffted = ffted.reshape(batch, -1, 2, height, half)
        real, imag = ffted[:, :, 0], ffted[:, :, 1]
        # irfftn with norm="ortho": inverse complex FFT along the height, then inverse real FFT along the width,
        # which counts every frequency but the first (and the last, for even widths) twice.
        real, imag = cos_h @ real - sin_h @ imag, cos_h @ imag + sin_h @ real
        k = torch.arange(half)
        weight = torch.where((k == 0) | ((width % 2 == 0) & (k == width // 2)), 1.0, 2.0)
        return ((real * weight) @ cos_w.T - (imag * weight) @ sin_w.T) * scale


class SpectralTransform(nn.Module):
    def __init__(self, in_channels, out_channels):
        super().__init__()
        self.downsample = nn.Identity()
        self.conv1 = nn.Sequential(
            nn.Conv2d(in_channels, out_channels // 2, kernel_size=1, bias=False),
            nn.BatchNorm2d(out_channels // 2),
            nn.ReLU(inplace=True),
        )
        self.fu = FourierUnit(out_channels // 2)
        self.conv2 = nn.Conv2d(out_channels // 2, out_channels, kernel_size=1, bias=False)

    def forward(self, x):
        x = self.conv1(self.downsample(x))
        return self.conv2(x + self.fu(x))


class FFC(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, ratio_gin, ratio_gout, stride=1, padding=0,
                 dilation=1):
        super().__init__()
        in_cg = int(in_channels * ratio_gin)
        in_cl = in_channels - in_cg
        out_cg = int(out_channels * ratio_gout)
        out_cl = out_channels - out_cg
        self.ratio_gout = ratio_gout
        self.global_in_num = in_cg

        def conv(inputs, outputs):
            if inputs == 0 or outputs == 0:
                return nn.Identity()
            return nn.Conv2d(inputs, outputs, kernel_size, stride, padding, dilation, bias=False,
                             padding_mode="reflect")

        self.convl2l = conv(in_cl, out_cl)
        self.convl2g = conv(in_cl, out_cg)
        self.convg2l = conv(in_cg, out_cl)
        self.convg2g = nn.Identity() if in_cg == 0 or out_cg == 0 else SpectralTransform(in_cg, out_cg)
        self.gate = nn.Identity()

    def forward(self, x):
        x_l, x_g = x if type(x) is tuple else (x, 0)
        out_xl, out_xg = 0, 0
        if self.ratio_gout != 1:
            out_xl = self.convl2l(x_l) + self.convg2l(x_g)
        if self.ratio_gout != 0:
            out_xg = self.convl2g(x_l) + self.convg2g(x_g)
        return out_xl, out_xg


class FFC_BN_ACT(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, ratio_gin, ratio_gout, stride=1, padding=0,
                 dilation=1):
        super().__init__()
        self.ffc = FFC(in_channels, out_channels, kernel_size, ratio_gin, ratio_gout, stride, padding, dilation)
        global_channels = int(out_channels * ratio_gout)
        self.bn_l = nn.Identity() if ratio_gout == 1 else nn.BatchNorm2d(out_channels - global_channels)
        self.bn_g = nn.Identity() if ratio_gout == 0 else nn.BatchNorm2d(global_channels)
        self.act_l = nn.Identity() if ratio_gout == 1 else nn.ReLU(inplace=True)
        self.act_g = nn.Identity() if ratio_gout == 0 else nn.ReLU(inplace=True)

    def forward(self, x):
        x_l, x_g = self.ffc(x)
        return self.act_l(self.bn_l(x_l)), self.act_g(self.bn_g(x_g))


class FFCResnetBlock(nn.Module):
    def __init__(self, dim, ratio):
        super().__init__()
        self.conv1 = FFC_BN_ACT(dim, dim, 3, ratio, ratio, padding=1)
        self.conv2 = FFC_BN_ACT(dim, dim, 3, ratio, ratio, padding=1)

    def forward(self, x):
        x_l, x_g = x
        y_l, y_g = self.conv2(self.conv1((x_l, x_g)))
        return x_l + y_l, x_g + y_g


class ConcatTupleLayer(nn.Module):
    def forward(self, x):
        return torch.cat(x, dim=1)


class Generator(nn.Module):
    """big-lama's generator: 4 input channels (masked RGB and mask), 3 downsamplings, 18 resnet blocks of which
    three quarters of the channels are global."""

    def __init__(self, ngf=64, n_downsampling=3, n_blocks=18, ratio=0.75):
        super().__init__()
        model = [nn.ReflectionPad2d(3), FFC_BN_ACT(4, ngf, 7, 0, 0)]
        for i in range(n_downsampling):
            mult = 2 ** i
            ratio_gout = ratio if i == n_downsampling - 1 else 0
            model.append(FFC_BN_ACT(ngf * mult, ngf * mult * 2, 3, 0, ratio_gout, stride=2, padding=1))
        features = ngf * 2 ** n_downsampling
        model += [FFCResnetBlock(features, ratio) for _ in range(n_blocks)]
        model.append(ConcatTupleLayer())
        for i in range(n_downsampling):
            mult = 2 ** (n_downsampling - i)
            model += [
                nn.ConvTranspose2d(ngf * mult, ngf * mult // 2, kernel_size=3, stride=2, padding=1, output_padding=1),
                nn.BatchNorm2d(ngf * mult // 2),
                nn.ReLU(True),
            ]
        model += [nn.ReflectionPad2d(3), nn.Conv2d(ngf, 3, kernel_size=7), nn.Sigmoid()]
        self.model = nn.Sequential(*model)

    def forward(self, x):
        return self.model(x)


class Lama(nn.Module):
    """Fills the masked pixels (mask 1) and keeps the rest, like big-lama.pt's own forward."""

    def __init__(self):
        super().__init__()
        self.generator = Generator()

    def forward(self, image, mask):
        masked = image * (1 - mask)
        return mask * self.generator(torch.cat([masked, mask], 1)) + (1 - mask) * image
