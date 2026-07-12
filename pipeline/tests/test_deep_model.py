import unittest

from pipeline.contourcast import deep_model


class DeepModelTests(unittest.TestCase):
    def test_dependency_guard_or_architecture_shapes(self):
        if deep_model.torch is None:
            with self.assertRaisesRegex(RuntimeError, "PyTorch is required"):
                deep_model.architecture_smoke_test()
        else:
            result = deep_model.architecture_smoke_test(batch_size=4, patch_size=17)
            self.assertEqual(result["status"], "architecture_smoke_only")
            self.assertEqual(result["input_shape"], [4, 6, 17, 17])
            self.assertTrue(result["finite_losses"])
            multiscale = deep_model.architecture_smoke_test(
                batch_size=4, patch_size=17, input_channels=10, scales=3
            )
            self.assertEqual(multiscale["input_shape"], [4, 3, 10, 17, 17])
            self.assertEqual(multiscale["area_bag_attention_shape"], [4, 2])
            self.assertTrue(multiscale["finite_losses"])
            first = deep_model.torch.randn(4, 8)
            second = deep_model.torch.randn(4, 8)
            coordinates = deep_model.torch.tensor(
                [[0.0, 0.0], [10.0, 0.0], [1000.0, 0.0], [2000.0, 0.0]]
            )
            loss = deep_model.spatial_nt_xent_loss(
                first,
                second,
                coordinates,
                min_negative_distance_m=100,
            )
            self.assertTrue(bool(deep_model.torch.isfinite(loss)))


if __name__ == "__main__":
    unittest.main()
